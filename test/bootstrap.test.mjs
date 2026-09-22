// test/bootstrap.test.mjs — the composition the host actually performs.
//
// The refresh replaces the old route-duplication approach: apply() installs the
// plugin's settings section, sweeps every hooked-up provider against one
// models.dev read (at bootstrap and on the refresh timer), and serves one HTTP
// endpoint the "update models from models.dev API" button drives. It must never
// register routes of its own — the point is to keep the existing providers
// current, not to duplicate them.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const NS = 'dsh-models-dev';
const REFRESH_PATH = '/api/dsh-models-dev/refresh';

/** One models.dev model record. */
const model = (id, overrides = {}) => ({
  id,
  name: id.toUpperCase(),
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 1000, output: 100 },
  ...overrides,
});

/** One catalog payload, as ModelsDevSync delivers it. */
const CATALOG = {
  'opencode-go': { models: { a: model('a'), b: model('b', { modalities: { input: ['text', 'image'], output: ['text'] } }) } },
  zai: { models: { c: model('c') } },
};

const PROVIDER_ROWS = [
  { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
  { provider: 'zai', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
  { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek'] },
];

/** A minimal HTTP request body reader the endpoint accepts. */
function fakeRequest(payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  return {
    method: 'POST',
    url: REFRESH_PATH,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

/** A minimal response sink capturing the status code and JSON body. */
function fakeResponse() {
  const captured = { status: undefined, body: undefined };
  return {
    captured,
    setHeader() {},
    writeHead(status) {
      captured.status = status;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body = JSON.parse(String(chunk));
    },
  };
}

/**
 * Build the host-shaped context: settings seam, llm directory, webserver seat.
 * The llm seam throws on any route registration — the refresh owns none.
 */
function harness({ autoSync = true, sources = {}, views, lateWebServer = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-models-dev-boot-'));
  const cachePath = join(home, 'models.dev.json');
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: CATALOG }));
  process.env.DSH_HOME = home;

  // An unreachable catalog URL keeps the suite hermetic: forced sweeps fail
  // fast and fall back to the fixture cache instead of hitting models.dev.
  const resolved = { modelsDevUrl: 'http://127.0.0.1:9/unreachable', refreshHours: 24, cachePath, autoSync, sources };
  const sections = [];
  const writes = [];
  const routes = [];
  const errors = [];
  const namespaceViews = views ?? [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 5 }];

  const settings = {
    installSection(_owner, ns, _schema, _entry, hooks) {
      if (sections.includes(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
      sections.push(ns);
      hooks.setSource(() => resolved);
      hooks.onChange();
    },
    describe: () => namespaceViews,
    mutate: async (ns, ops, expectedRevision) => {
      writes.push({ ns, ops, expectedRevision });
    },
  };

  const llm = {
    listConfigurableProviders: () => PROVIDER_ROWS,
    registerAdapter() {
      throw new Error('the refresh must not register llm routes');
    },
    registerConfigurableProviders() {
      throw new Error('the refresh must not register llm routes');
    },
    registerModelDiscovery() {
      throw new Error('the refresh must not register llm routes');
    },
  };

  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };

  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
    llm,
    webServer,
    // Cordis semantics: `ctx.get(name)` is strict — reading a service the fiber
    // did not declare in `inject` throws "cannot get property ... without
    // inject"; only `ctx.get(name, false)` is lenient. The harness enforces that
    // so a plain property read can never sneak back in.
    injected: new Set(['llm']),
    get(name, strict = true) {
      if (strict && !this.injected.has(name)) throw new Error(`cannot get property "${name}" without inject`);
      if (name === 'settings') return settings;
      if (name === 'webServer') return lateWebServer ? undefined : webServer;
      return undefined;
    },
    on: () => {},
    effect: () => {},
    inject: (deps, callback) => {
      const provided = {};
      for (const dep of deps) provided[dep] = dep === 'settings' ? settings : webServer;
      callback(provided);
    },
  };

  return { ctx, home, sections, writes, routes, errors };
}

/** Wait until the plugin's own trace reports the bootstrap finished. */
async function waitForBootstrap(home, timeoutMs = 5000) {
  const tracePath = join(home, 'plugins', NS, 'bootstrap.log');
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = readFileSync(tracePath, 'utf8');
      if (/bootstrap: (done|FAILED)/.test(text)) return text;
    } catch {
      // the trace appears once apply() runs
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return text;
}

/** Import the plugin after DSH_HOME points at the harness state dir. */
async function loadPlugin() {
  return import(new URL('../index.js', import.meta.url).href);
}

test('apply installs the settings section and refreshes every hooked-up route', async () => {
  const h = harness();
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  const trace = await waitForBootstrap(h.home);

  assert.equal(h.errors.length, 0, `bootstrap logged errors: ${JSON.stringify(h.errors)}`);
  assert.deepEqual(h.sections, [NS], 'the settings section is installed exactly once');
  assert.deepEqual(h.writes.map((write) => write.ops[0].path[1]), ['opencode-go', 'zai'], 'both pi-ai routes are refreshed; deepseek is left alone');
  assert.equal(h.writes[0].expectedRevision, 5);
  assert.deepEqual(h.writes[0].ops[0].value, [
    { id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text'] },
    { id: 'b', name: 'B', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'] },
  ]);
  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
});

test('apply serves the refresh endpoint the icon drives', async () => {
  const h = harness();
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, `registered routes: ${h.routes.map((candidate) => candidate.path).join(', ') || 'none'}`);
  assert.equal(route.kind, 'exact');

  h.writes.length = 0;
  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }), res);

  assert.equal(res.captured.status, 200);
  assert.deepEqual(res.captured.body, { ok: true, results: [{ route: 'zai', source: 'zai', added: 1, updated: 0 }] });
  assert.deepEqual(h.writes.map((write) => write.ops[0].path[1]), ['zai'], 'the endpoint refreshes exactly the requested route');
});

test('apply skips the automatic sweep when autoSync is off', async () => {
  const h = harness({ autoSync: false });
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  const trace = await waitForBootstrap(h.home);

  assert.deepEqual(h.writes, [], 'no automatic write');
  assert.equal(h.routes.length, 1, 'the manual refresh endpoint stays available');
  assert.match(trace, /bootstrap: done/);
});

test('apply follows the sources override for custom route keys', async () => {
  const h = harness({
    sources: { zai: 'opencode-go' },
    views: [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 2 }],
  });
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  await waitForBootstrap(h.home);

  const zai = h.writes.find((write) => write.ops[0].path[1] === 'zai');
  assert.ok(zai, 'the zai route is refreshed');
  assert.deepEqual(zai.ops[0].value.map((entry) => entry.id), ['a', 'b'], 'its models come from the opencode-go source');
});

test('apply seats the refresh endpoint even when the webserver appears late', async () => {
  const h = harness({ lateWebServer: true });
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, `registered routes: ${h.routes.map((candidate) => candidate.path).join(', ') || 'none'} (the seat arrives through inject)`);
});
