// test/service.test.mjs — the host-side refresh orchestration.
//
// The refresh walks the configurable-provider directory (everything hooked up
// through ctx.llm), keeps the pi-ai family rows whose model shape this plugin
// writes, maps each route to its models.dev source (route key by default,
// `sources` overrides), merges the catalog into the row's `models` array and
// writes it back with the settings seam's path ops and revision fencing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncRoutes } from '../lib/service.mjs';

/** One models.dev model record. */
const model = (id, overrides = {}) => ({
  id,
  name: id.toUpperCase(),
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 1000, output: 100 },
  ...overrides,
});

/** The settings seam as the host exposes it: describe() is an array; mutate() throws. */
function fakeSettings({ views, writes }) {
  return {
    describe: () => views,
    mutate: async (ns, ops, expectedRevision) => {
      writes.push({ ns, ops, expectedRevision });
    },
  };
}

const PROVIDERS = [
  { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
  { provider: 'zai', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
  { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek'] },
];

test('syncRoutes refreshes every hooked-up pi-ai route and reports counts', async () => {
  const writes = [];
  const settings = fakeSettings({
    writes,
    views: [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 7 }],
  });
  const catalog = {
    'opencode-go': { models: { a: model('a'), b: model('b', { modalities: { input: ['text', 'image'], output: ['text'] } }) } },
    zai: { models: { c: model('c') } },
  };

  const results = await syncRoutes({ settings, providers: PROVIDERS, catalog });

  assert.equal(writes.length, 2, 'the deepseek row (other namespace) is never written');
  assert.deepEqual(writes[0].ops, [
    { op: 'set', path: ['providers', 'opencode-go', 'models'], value: [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text'] }, { id: 'b', name: 'B', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'] }] },
    { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
  ]);
  assert.deepEqual(writes[1].ops[0].path, ['providers', 'zai', 'models']);
  assert.deepEqual(results, [
    { route: 'opencode-go', source: 'opencode-go', added: 2, updated: 0 },
    { route: 'zai', source: 'zai', added: 1, updated: 0 },
  ]);
});

test('syncRoutes skips a route the catalog does not describe', async () => {
  const writes = [];
  const settings = fakeSettings({ writes, views: [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 1 }] });
  const results = await syncRoutes({ settings, providers: PROVIDERS, catalog: {} });
  assert.equal(writes.length, 0);
  assert.deepEqual(results, [
    { route: 'opencode-go', source: 'opencode-go', skipped: 'no-catalog-source' },
    { route: 'zai', source: 'zai', skipped: 'no-catalog-source' },
  ]);
});

test('syncRoutes follows the sources override for custom route keys', async () => {
  const writes = [];
  const settings = fakeSettings({ writes, views: [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go-live': {} } }, user: {}, revision: 2 }] });
  const custom = [{ provider: 'opencode-go-live', displayName: 'live', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go-live'] }];
  const catalog = { 'opencode-go': { models: { a: model('a') } } };

  const results = await syncRoutes({ settings, providers: custom, catalog, sources: { 'opencode-go-live': 'opencode-go' } });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'opencode-go-live', 'models']);
  assert.deepEqual(results, [{ route: 'opencode-go-live', source: 'opencode-go', added: 1, updated: 0 }]);
});

test('syncRoutes merges the catalog into the user-layer rows it finds', async () => {
  const writes = [];
  const settings = fakeSettings({
    writes,
    views: [{
      ns: 'llm-pi-ai',
      value: { providers: { 'opencode-go': { models: [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100 }] } } },
      user: { providers: { 'opencode-go': { models: [{ id: 'a', name: 'Hand', input: ['text'] }, { id: 'hand-only', name: 'Custom' }] } } },
      revision: 9,
    }],
  });
  const catalog = { 'opencode-go': { models: { a: model('a', { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }) } } };

  await syncRoutes({ settings, providers: [PROVIDERS[0]], catalog });

  const entries = writes[0].ops[0].value;
  assert.deepEqual(entries, [
    { id: 'a', name: 'Hand', input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' }, contextWindow: 1000, maxTokens: 100 },
    { id: 'hand-only', name: 'Custom' },
  ]);
  assert.equal(writes[0].expectedRevision, 9);
});

test('syncRoutes reports a route whose settings namespace is not registered', async () => {
  const writes = [];
  const settings = fakeSettings({ writes, views: [] });
  const results = await syncRoutes({ settings, providers: [PROVIDERS[0]], catalog: { 'opencode-go': { models: { a: model('a') } } } });
  assert.equal(writes.length, 0);
  assert.deepEqual(results, [{ route: 'opencode-go', source: 'opencode-go', skipped: 'namespace-not-registered' }]);
});

test('syncRoutes reports a refused write and keeps sweeping the rest', async () => {
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision: 3 }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
      if (ops[0].path[1] === 'zai') throw new Error('settings namespace moved past the revision it was read at');
    },
  };
  const catalog = {
    'opencode-go': { models: { a: model('a') } },
    zai: { models: { c: model('c') } },
  };

  const results = await syncRoutes({ settings, providers: PROVIDERS, catalog });

  assert.equal(writes.length, 2, 'the refused write does not stop the sweep');
  assert.deepEqual(results, [
    { route: 'opencode-go', source: 'opencode-go', added: 1, updated: 0 },
    { route: 'zai', source: 'zai', error: 'settings namespace moved past the revision it was read at' },
  ]);
});

test('syncRoutes refreshes several routes of one namespace in one sweep', async () => {
  // One namespace, one revision counter: every write bumps it, so a sweep that
  // fences every write against a single stale read conflicts after the first.
  let revision = 0;
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': {}, zai: {} } }, user: {}, revision }],
    mutate: async (ns, ops, expectedRevision) => {
      if (expectedRevision !== revision) throw new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${revision})`);
      writes.push({ ns, ops });
      revision += 1;
    },
  };
  const catalog = {
    'opencode-go': { models: { a: model('a') } },
    zai: { models: { c: model('c') } },
  };

  const results = await syncRoutes({ settings, providers: PROVIDERS, catalog });

  assert.equal(writes.length, 2, 'both writes land');
  assert.deepEqual(results.map((result) => result.route), ['opencode-go', 'zai']);
  assert.ok(results.every((result) => result.error === undefined), JSON.stringify(results));
});

test('syncRoutes only touches routes that are actually hooked up', async () => {
  const writes = [];
  const settings = {
    // opencode-go carries a profile (hooked up); zai exists only as a declared
    // configurable provider the user never configured.
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': { models: [] } } }, user: {}, revision: 1 }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = {
    'opencode-go': { models: { a: model('a') } },
    zai: { models: { c: model('c') } },
  };

  const results = await syncRoutes({ settings, providers: PROVIDERS, catalog });

  assert.equal(writes.length, 1, 'only the hooked-up route is written');
  assert.deepEqual(results, [
    { route: 'opencode-go', source: 'opencode-go', added: 1, updated: 0 },
    { route: 'zai', source: 'zai', skipped: 'not-configured' },
  ]);
});

test('syncRoutes fills the route api so models the catalog lacks can resolve', async () => {
  // A model absent from pi-ai's catalog resolves its api off the route profile;
  // a provider whose catalog mixes protocols has no shared api, so the profile
  // must name one (llm-pi-ai: "model X needs an api; ... set the route's api").
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': { models: [] } } }, user: {}, revision: 1 }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = { 'opencode-go': { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/go/v1', models: { a: model('a') } } };

  await syncRoutes({ settings, providers: [PROVIDERS[0]], catalog });

  assert.deepEqual(writes[0].ops, [
    { op: 'set', path: ['providers', 'opencode-go', 'models'], value: [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
    { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
    { op: 'set', path: ['providers', 'opencode-go', 'baseURL'], value: 'https://opencode.ai/zen/go/v1' },
  ]);
});

test('syncRoutes never overrides a route api the user set', async () => {
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': { api: 'anthropic-messages', baseURL: 'https://x', models: [] } } }, user: {}, revision: 1 }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = { 'opencode-go': { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/go/v1', models: { a: model('a') } } };

  await syncRoutes({ settings, providers: [PROVIDERS[0]], catalog });

  assert.equal(writes[0].ops.length, 1, 'only the models are written');
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'opencode-go', 'models']);
});
