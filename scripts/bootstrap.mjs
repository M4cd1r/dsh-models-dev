// scripts/bootstrap.mjs — prove the plugin bootstraps inside the running dsh.
//
// Mirrors the host composition: the settings section swaps the live config in,
// the llm directory lists what is hooked up, the webserver seat carries the
// refresh endpoint, and the llm seam refuses any route registration (the
// refresh owns none — duplicating providers is what this plugin replaced).
//
// Usage: node scripts/bootstrap.mjs [path/to/index.js]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NS = 'dsh-models-dev';
const REFRESH_PATH = '/api/dsh-models-dev/refresh';
const pluginIndex = process.argv[2] ?? fileURLToPath(new URL('../index.js', import.meta.url));

const model = (id, overrides = {}) => ({
  id,
  name: id.toUpperCase(),
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 1000, output: 100 },
  ...overrides,
});

const CATALOG = {
  'opencode-go': { models: { a: model('a'), b: model('b', { modalities: { input: ['text', 'image'], output: ['text'] } }) } },
  zai: { models: { c: model('c') } },
};

const PROVIDER_ROWS = [
  { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
  { provider: 'zai', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
  { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek'] },
];

const home = mkdtempSync(join(tmpdir(), 'dsh-models-dev-bootstrap-'));
process.env.DSH_HOME = home;
const cachePath = join(home, 'bootstrap-catalog.json');
writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: CATALOG }));

const RESOLVED = { modelsDevUrl: 'http://127.0.0.1:9/unreachable', refreshHours: 24, cachePath, autoSync: true, sources: {} };

const sections = [];
const writes = [];
const routes = [];
const errors = [];

const settings = {
  installSection(_owner, ns, _schema, _entry, hooks) {
    sections.push(ns);
    hooks.setSource(() => RESOLVED);
    hooks.onChange();
  },
  describe: () => [{ ns: 'llm-pi-ai', value: {}, user: {}, revision: 4 }],
  mutate: async (ns, ops, expectedRevision) => {
    writes.push({ ns, ops, expectedRevision });
  },
};

const llm = {
  listConfigurableProviders: () => PROVIDER_ROWS,
  registerAdapter() { throw new Error('the refresh must not register llm routes'); },
  registerConfigurableProviders() { throw new Error('the refresh must not register llm routes'); },
  registerModelDiscovery() { throw new Error('the refresh must not register llm routes'); },
};

const webServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};

const ctx = {
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) => errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
  },
  llm,
  webServer,
  get: (name) => (name === 'settings' ? settings : name === 'webServer' ? webServer : undefined),
  on: () => {},
  effect: () => {},
  inject: (_deps, callback) => callback({ settings }),
};

const { apply } = await import(pathToFileURL(pluginIndex).href);
apply(ctx, {});

const tracePath = join(home, 'plugins', NS, 'bootstrap.log');
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(tracePath) && /bootstrap: (done|FAILED)/.test(readFileSync(tracePath, 'utf8'))) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';

// One manual refresh through the endpoint the icon drives.
const route = routes.find((candidate) => candidate.path === REFRESH_PATH);
let manual = 'endpoint missing';
let manualOk = false;
if (route !== undefined) {
  const body = Buffer.from(JSON.stringify({ route: 'zai' }));
  const req = {
    method: 'POST',
    url: REFRESH_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield body; },
  };
  const captured = { status: undefined, body: undefined };
  const res = {
    setHeader() {},
    writeHead(status) { captured.status = status; },
    end(chunk) { if (chunk !== undefined) captured.body = JSON.parse(String(chunk)); },
  };
  await route.handler(req, res);
  manual = `POST ${REFRESH_PATH} {route:zai} -> ${captured.status} ${JSON.stringify(captured.body)}`;
  manualOk = captured.status === 200 && captured.body?.ok === true && captured.body.results?.[0]?.route === 'zai';
}

const swept = writes.map((write) => write.ops[0].path[1]);
const problems = [];
if (!sections.includes(NS)) problems.push(`no settings section for "${NS}"`);
if (!swept.includes('opencode-go') || !swept.includes('zai')) problems.push(`the automatic sweep wrote: ${swept.join(', ') || 'none'}`);
if (swept.includes('deepseek')) problems.push('the deepseek row (other namespace) must not be touched');
if (route === undefined) problems.push(`no refresh endpoint on ${REFRESH_PATH}`);
else if (!manualOk) problems.push(`manual refresh failed: ${manual}`);
if (/bootstrap: FAILED/.test(trace)) {
  problems.push(`trace reports a failure:\n${trace.split('\n').filter((line) => line.includes('FAILED')).join('\n')}`);
}
if (errors.length > 0) problems.push(`logger errors: ${errors.join(' | ')}`);

if (problems.length > 0) {
  console.error(`bootstrap: FAIL — ${problems.join('; ')}`);
  process.exit(1);
}

console.log(`bootstrap: OK — section "${NS}", swept ${swept.join(',')}, ${manual}`);
