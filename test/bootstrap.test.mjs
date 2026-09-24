// test/bootstrap.test.mjs — the composition the host actually performs.
//
// The refresh replaces the old route-duplication approach: apply() attaches the
// 0.1.7 settings seam (the host derives the plugin's form from the volatile
// Config schema; there is no section to install), sweeps every hooked-up
// provider against one models.dev read (at bootstrap, on the refresh timer and
// after a volatile config edit), and serves one HTTP endpoint the "update
// models from models.dev API" button drives. It must never register routes of
// its own — the point is to keep the existing providers current, not to
// duplicate them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

/**
 * A minimal HTTP request double the endpoint accepts.
 *
 * Event-based on purpose: the endpoint reads bodies with data/end/error
 * listeners, not with the stream async iterator — the iterator hangs (and then
 * crashes the host on abort) when the request arrives through the LAN replay
 * Proxy. See test/lan-proxy.test.mjs for the live-server version of that.
 * @param payload - parsed body to deliver, JSON-encoded.
 * @param options.fail - emit a request-stream error instead of a body.
 */
function fakeRequest(payload, { fail } = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = REFRESH_PATH;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  // Listeners are attached synchronously by the handler; deliver on the next
  // tick, exactly like node:http delivering a body after the headers.
  setImmediate(() => {
    if (fail !== undefined) {
      req.emit('error', new Error(fail));
      return;
    }
    if (body.length > 0) req.emit('data', body);
    req.emit('end');
  });
  return req;
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
 * @param options.lateWebServer - the webserver seat is not up when apply() runs.
 * @param options.lateSettings - the settings service is not up when apply() runs
 * (it reaches the armed inject on a later tick, after "bootstrap: done").
 * @param options.volatile - hand apply() loader-shaped references (`{ get() }`)
 * over the resolved values instead of plain values.
 */
function harness({ autoSync = true, sources = {}, views, lateWebServer = false, lateSettings = false, volatile = false, cache = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-models-dev-boot-'));
  const cachePath = join(home, 'models.dev.json');
  if (cache) writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: CATALOG }));
  process.env.DSH_HOME = home;

  // An unreachable catalog URL keeps the suite hermetic: forced sweeps fail
  // fast and fall back to the fixture cache instead of hitting models.dev.
  const resolved = { modelsDevUrl: 'http://127.0.0.1:9/unreachable', refreshHours: 24, cachePath, autoSync, sources };
  const writes = [];
  const routes = [];
  const errors = [];
  const listeners = [];
  const namespaceViews = views ?? [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 5 }];

  // The 0.1.7 settings service: exactly describe and mutate — installSection
  // is gone, and the plugin must not call anything else on the seam.
  const settings = {
    describe: () => namespaceViews,
    mutate: async (ns, ops, expectedRevision) => {
      writes.push({ ns, ops, expectedRevision });
    },
  };

  // The loader hands apply() references for volatile fields and updates them in
  // place on an edit; `volatile` builds that shape over the same live values.
  const config = volatile
    ? {
        modelsDevUrl: { get: () => resolved.modelsDevUrl },
        refreshHours: { get: () => resolved.refreshHours },
        cachePath: { get: () => resolved.cachePath },
        autoSync: { get: () => resolved.autoSync },
        sources: { get: () => resolved.sources },
      }
    : resolved;

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
      if (name === 'settings') return lateSettings ? undefined : settings;
      if (name === 'webServer') return lateWebServer ? undefined : webServer;
      return undefined;
    },
    // Events are captured, not dropped: a test emits the loader's edit event
    // exactly the way the real loader does.
    on: (event, callback) => {
      listeners.push({ event, callback });
      return () => {};
    },
    effect: () => {},
    inject: (deps, callback) => {
      const provided = {};
      for (const dep of deps) provided[dep] = dep === 'settings' ? settings : webServer;
      if (lateSettings && deps.includes('settings')) setImmediate(() => callback(provided));
      else callback(provided);
    },
  };

  return { ctx, home, resolved, config, writes, routes, errors, listeners };
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

/** Poll until the predicate holds; the sweep and the late seam land asynchronously. */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Wait until the trace matches — late steps (the seam, later sweeps) trace after "done". */
async function waitForTrace(home, pattern, timeoutMs = 5000) {
  const tracePath = join(home, 'plugins', NS, 'bootstrap.log');
  const matched = await waitFor(() => {
    try {
      return pattern.test(readFileSync(tracePath, 'utf8'));
    } catch {
      return false;
    }
  }, timeoutMs);
  try {
    return matched ? readFileSync(tracePath, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Emit one captured event the way the real loader does. */
function fire(harness, event) {
  for (const listener of harness.listeners.filter((row) => row.event === event)) listener.callback();
}

/** Import the plugin after DSH_HOME points at the harness state dir. */
async function loadPlugin() {
  return import(new URL('../index.js', import.meta.url).href);
}

test('apply attaches the settings seam and refreshes every hooked-up route', async () => {
  const h = harness();
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  const trace = await waitForBootstrap(h.home);

  assert.equal(h.errors.length, 0, `bootstrap logged errors: ${JSON.stringify(h.errors)}`);
  assert.deepEqual(h.writes.map((write) => write.ops[0].path[1]), ['opencode-go', 'zai'], 'both pi-ai routes are refreshed; deepseek is left alone');
  assert.equal(h.writes[0].expectedRevision, 5);
  assert.deepEqual(h.writes[0].ops[0].value, [
    { id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text'] },
    { id: 'b', name: 'B', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'] },
  ]);
  assert.match(trace, /bootstrap: settings seam attached/);
  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
});

test('apply serves the refresh endpoint the icon drives', async () => {
  const h = harness();
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, `registered routes: ${h.routes.map((candidate) => candidate.path).join(', ') || 'none'}`);
  assert.equal(route.kind, 'exact');

  h.writes.length = 0;
  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }), res);

  assert.equal(res.captured.status, 200);
  assert.equal(res.captured.body.ok, true);
  assert.deepEqual(res.captured.body.results, [{ route: 'zai', source: 'zai', added: 1, updated: 0 }]);
  assert.ok(
    Array.isArray(res.captured.body.log) && res.captured.body.log.some((line) => line.includes('refresh:')),
    `the attempt log rides along for the client's toasts: ${JSON.stringify(res.captured.body.log)}`,
  );
  assert.deepEqual(h.writes.map((write) => write.ops[0].path[1]), ['zai'], 'the endpoint refreshes exactly the requested route');
});

test('apply skips the automatic sweep when autoSync is off', async () => {
  const h = harness({ autoSync: false });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
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
  apply(h.ctx, h.config);
  await waitForBootstrap(h.home);

  const zai = h.writes.find((write) => write.ops[0].path[1] === 'zai');
  assert.ok(zai, 'the zai route is refreshed');
  assert.deepEqual(zai.ops[0].value.map((entry) => entry.id), ['a', 'b'], 'its models come from the opencode-go source');
});

test('a failed sweep answers the endpoint with the error, its stack and the log', async () => {
  // No cache + an unreachable catalog: the forced sweep throws for real, and
  // the error notification needs the stack and the attempt log to show them.
  const h = harness({ autoSync: false, cache: false });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, 'the refresh endpoint is registered');

  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }), res);

  assert.equal(res.captured.status, 400);
  assert.equal(res.captured.body.ok, false);
  assert.match(res.captured.body.error, /could not fetch/, 'the failure message is reported');
  assert.match(String(res.captured.body.stack), /Error|\bat\b/, 'the stack trace rides along');
  assert.ok(
    Array.isArray(res.captured.body.log) && res.captured.body.log.some((line) => line.includes('refresh: loading catalog')),
    `the attempt log rides along: ${JSON.stringify(res.captured.body.log)}`,
  );
});

test('a request whose stream errors answers 400 instead of hanging the host', async () => {
  // What a browser abort looks like server-side. The old body reader (stream
  // async iterator) hung here through the LAN replay Proxy and then killed the
  // process; the endpoint must simply answer with the failure.
  const h = harness({ autoSync: false });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, 'the refresh endpoint is registered');

  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }, { fail: 'aborted' }), res);

  assert.equal(res.captured.status, 400);
  assert.equal(res.captured.body.ok, false);
  assert.match(res.captured.body.error, /aborted/, 'the request failure is reported');
});

test('apply seats the refresh endpoint even when the webserver appears late', async () => {
  const h = harness({ lateWebServer: true });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  await waitForBootstrap(h.home);

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, `registered routes: ${h.routes.map((candidate) => candidate.path).join(', ') || 'none'} (the seat arrives through inject)`);
});

test('a late settings service still sweeps and serves the refresh endpoint', async () => {
  // The live 0.1.7 failure: the late branch called installSection, the throw
  // left state.settings undefined, and every sweep died at its guard — the
  // endpoint answered 200 {ok:true,results:[],log:[]} and nothing was written.
  const h = harness({ lateSettings: true });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  const trace = await waitForBootstrap(h.home);

  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
  const attached = await waitForTrace(h.home, /settings seam attached/);
  assert.match(attached, /bootstrap: settings seam attached/);
  assert.ok(await waitFor(() => h.writes.length > 0), 'the automatic sweep ran once the seam arrived');
  assert.deepEqual(h.writes.map((write) => write.ops[0].path[1]), ['opencode-go', 'zai'], 'both pi-ai routes are refreshed');
  assert.equal(h.errors.length, 0, `errors: ${JSON.stringify(h.errors)}`);

  h.writes.length = 0;
  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, 'the refresh endpoint is registered');
  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }), res);

  assert.equal(res.captured.status, 200);
  assert.equal(res.captured.body.ok, true);
  assert.deepEqual(res.captured.body.results, [{ route: 'zai', source: 'zai', added: 1, updated: 0 }]);
  assert.ok(
    Array.isArray(res.captured.body.log) && res.captured.body.log.length > 0,
    `the attempt log is non-empty — the live symptom was an empty one: ${JSON.stringify(res.captured.body.log)}`,
  );
});

test('a volatile config is read live and re-swept on loader/volatile-update', async () => {
  const h = harness({ volatile: true, autoSync: false, sources: { zai: 'opencode-go' } });
  const { apply } = await loadPlugin();
  apply(h.ctx, h.config);
  const trace = await waitForBootstrap(h.home);

  assert.match(trace, /bootstrap: done/);
  assert.deepEqual(h.writes, [], 'autoSync=false through a reference gates the automatic write');

  const route = h.routes.find((candidate) => candidate.path === REFRESH_PATH);
  assert.ok(route, 'the refresh endpoint is registered');
  const res = fakeResponse();
  await route.handler(fakeRequest({ route: 'zai' }), res);
  assert.equal(res.captured.status, 200);
  const zai = h.writes.find((write) => write.ops[0].path[1] === 'zai');
  assert.ok(zai, 'the endpoint sweep wrote the route');
  assert.deepEqual(zai.ops[0].value.map((entry) => entry.id), ['a', 'b'], 'the sources remap reached the write');

  // The loader's edit: the same references now answer new values, then the
  // entry's fiber gets loader/volatile-update.
  h.writes.length = 0;
  h.resolved.sources = {};
  fire(h, 'loader/volatile-update');
  assert.ok(await waitFor(() => h.writes.length >= 2), `the volatile update re-swept: ${JSON.stringify(h.writes)}`);
  const swept = h.writes.map((write) => write.ops[0].path[1]);
  assert.deepEqual(swept, ['opencode-go', 'zai'], 'the fresh sweep covered every route');
  const zaiAgain = h.writes.filter((write) => write.ops[0].path[1] === 'zai').at(-1);
  assert.deepEqual(zaiAgain.ops[0].value.map((entry) => entry.id), ['c'], 'the new sources value reached the write');
  assert.equal(h.errors.length, 0, `errors: ${JSON.stringify(h.errors)}`);
});
