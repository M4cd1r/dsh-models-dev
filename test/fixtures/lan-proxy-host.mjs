// test/fixtures/lan-proxy-host.mjs — a host stand-in for the LAN replay crash.
//
// Runs the plugin's real refresh endpoint behind a real node:http server and
// hands trusted-LAN requests a Proxy over the request — the exact shape
// dsh-lan-replay's asLoopback() builds (same fields, same Proxy). Prints
// `READY <port>` once the endpoint is registered, then serves until killed.
//
// The regression this pins (see index.js readJsonBody): with the request read
// through `for await`, the proxied request made the body read hang forever, and
// the first request-stream error after that killed the whole process with an
// uncaught "TypeError: callback is not a function".
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../index.js';

const REFRESH_PATH = '/api/dsh-models-dev/refresh';
const TRUSTED_HOSTS = ['192.168.1.72:3080'];

/** The living-catalog stand-in this host serves (no network in tests). */
const CATALOG = {
  'opencode-go': {
    models: {
      m: {
        id: 'm',
        name: 'M',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1000, output: 100 },
      },
    },
  },
};

/** dsh-lan-replay's asLoopback(): a Proxy that replays the request as loopback. */
function asLoopback(request, port) {
  const authority = `127.0.0.1:${port}`;
  const headers = {
    ...request.headers,
    host: authority,
    origin: `http://${authority}`,
    'sec-fetch-site': 'same-origin',
  };
  const socketProxy = new Proxy(request.socket, {
    get(target, prop, receiver) {
      if (prop === 'remoteAddress') return '127.0.0.1';
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(request, {
    get(target, prop, receiver) {
      if (prop === 'headers') return headers;
      if (prop === 'socket') return socketProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
}

const routes = new Map();
const errors = [];

// The 0.1.7 settings service: describe and mutate only — there is no section
// to install, and the live config values travel through apply()'s config.
const settings = {
  describe: () => [],
  mutate: async () => {},
};

const webServer = {
  port: 0,
  register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
  renderIndex: (html) => html,
};

const ctx = {
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) => errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
  },
  llm: { listConfigurableProviders: () => [] },
  webServer,
  get: (name) => (name === 'settings' ? settings : name === 'webServer' ? webServer : undefined),
  on: () => {},
  effect: () => {},
  inject: (_deps, callback) => callback({ settings, webServer }),
};

const server = http.createServer(async (req, res) => {
  const rawPath = new URL(req.url ?? '/', 'http://x').pathname;
  if (rawPath === '/catalog.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CATALOG));
    return;
  }
  const route = routes.get(rawPath);
  if (route === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  const host = String(req.headers.host ?? '');
  // Trusted non-loopback authority → replay as loopback, exactly like the LAN
  // replay plugin does for a real LAN client.
  const target = TRUSTED_HOSTS.includes(host) ? asLoopback(req, server.address().port) : req;
  try {
    await route.handler(target, res);
  } catch (error) {
    // The host's own dispatch logs a warning and answers 400.
    errors.push(String(error?.message ?? error));
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(400);
      res.end();
    }
  }
});

/** Live plugin config: the catalog is served by this very host. */
const resolved = {
  modelsDevUrl: '',
  refreshHours: 24,
  cachePath: undefined,
  autoSync: false,
  sources: {},
};

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
webServer.port = server.address().port;
resolved.modelsDevUrl = `http://127.0.0.1:${webServer.port}/catalog.json`;
// The catalog cache lives outside the repository: a test run must not leave
// artefacts in the working tree.
resolved.cachePath = join(mkdtempSync(join(tmpdir(), 'dsh-models-dev-lan-proxy-')), 'models.dev.json');

apply(ctx, resolved);

const deadline = Date.now() + 10_000;
while (Date.now() < deadline && !routes.has(REFRESH_PATH)) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!routes.has(REFRESH_PATH)) {
  console.error(`fixture: ${REFRESH_PATH} was never registered (${errors.join(' | ')})`);
  process.exit(3);
}

console.log(`READY ${webServer.port}`);
