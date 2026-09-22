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
  assert.deepEqual(results[0], { route: 'opencode-go', source: 'opencode-go', added: 1, updated: 0 });
  assert.equal(results[1].route, 'zai');
  assert.equal(results[1].error, 'settings namespace moved past the revision it was read at');
  assert.match(
    String(results[1].stack),
    /settings namespace moved past|\bat\b/,
    'the refused write carries its stack for the error notification',
  );
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

test('syncRoutes leaves the wire profile the installed catalog resolves alone', async () => {
  // The regression behind the fill rules: route "zai" carried no api/baseURL
  // while pi-ai's installed catalog resolved it to the GLM Coding Plan
  // endpoint. models.dev's same-named provider is the Z.AI open platform, and
  // the fill this test forbids pinned its endpoint over the working resolution
  // — every call then landed on a platform the key has no package for.
  const writes = [];
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { zai: { models: [] } } }, user: {}, revision: 1 }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = { zai: { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4', models: { c: model('c') } } };

  const results = await syncRoutes({ settings, providers: [PROVIDERS[1]], catalog });

  assert.equal(writes[0].ops.length, 1, 'only the models are written — the catalog resolution is not shadowed');
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'zai', 'models']);
  assert.deepEqual(results, [{ route: 'zai', source: 'zai', added: 1, updated: 0 }]);
});

test('syncRoutes fills the wire fields only when the strict validation refuses the write', async () => {
  // llm-pi-ai refuses a model that resolves neither api nor base URL through
  // any layer ("model X needs an api; ... set the route's api"); only that
  // refusal makes the route profile the right place for the wire values.
  const writes = [];
  let calls = 0;
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'opencode-go': { models: [] } } }, user: {}, revision: 1 }],
    mutate: async (ns, ops) => {
      calls += 1;
      if (calls === 1) throw new Error('llm-pi-ai: provider "opencode-go" model "a" needs an api; the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks');
      if (calls === 2) throw new Error('llm-pi-ai: provider "opencode-go" model "a" needs a baseURL; the installed catalog does not describe this route');
      writes.push({ ns, ops });
    },
  };
  const catalog = { 'opencode-go': { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/go/v1', models: { a: model('a') } } };

  const results = await syncRoutes({ settings, providers: [PROVIDERS[0]], catalog });

  assert.equal(calls, 3, 'models, then one fill per refused field');
  assert.deepEqual(writes[0].ops, [
    { op: 'set', path: ['providers', 'opencode-go', 'models'], value: [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
    { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
    { op: 'set', path: ['providers', 'opencode-go', 'baseURL'], value: 'https://opencode.ai/zen/go/v1' },
  ]);
  assert.deepEqual(results, [{ route: 'opencode-go', source: 'opencode-go', added: 1, updated: 0, filled: ['api', 'baseURL'] }]);
});

test('syncRoutes repairs a wire pin an earlier version filled when the source is remapped', async () => {
  // The value present here is exactly the pin the route-key mapping filled in
  // 0.1.x. With `sources` naming the Coding Plan provider, keeping that pin
  // would keep dispatching the open-platform endpoint — repair it.
  const writes = [];
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers: { zai: { api: 'openai-completions', baseURL: 'https://api.z.ai/api/paas/v4', models: [] } } },
      user: {},
      revision: 5,
    }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = {
    zai: { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4', models: { c: model('c') } },
    'zai-coding-plan': { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/coding/paas/v4', models: { c: model('c') } },
  };

  const results = await syncRoutes({ settings, providers: [PROVIDERS[1]], catalog, sources: { zai: 'zai-coding-plan' } });

  assert.deepEqual(writes[0].ops, [
    { op: 'set', path: ['providers', 'zai', 'models'], value: [{ id: 'c', name: 'C', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
    { op: 'set', path: ['providers', 'zai', 'baseURL'], value: 'https://api.z.ai/api/coding/paas/v4' },
  ]);
  assert.deepEqual(results, [{ route: 'zai', source: 'zai-coding-plan', added: 1, updated: 0, repaired: ['baseURL'] }]);
});

test('syncRoutes never rewrites a wire value that differs from its fill shape', async () => {
  const writes = [];
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers: { zai: { api: 'openai-completions', baseURL: 'https://my.proxy/v4', models: [] } } },
      user: {},
      revision: 5,
    }],
    mutate: async (ns, ops) => {
      writes.push({ ns, ops });
    },
  };
  const catalog = {
    zai: { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/paas/v4', models: { c: model('c') } },
    'zai-coding-plan': { npm: '@ai-sdk/openai-compatible', api: 'https://api.z.ai/api/coding/paas/v4', models: { c: model('c') } },
  };

  await syncRoutes({ settings, providers: [PROVIDERS[1]], catalog, sources: { zai: 'zai-coding-plan' } });

  assert.equal(writes[0].ops.length, 1, 'a user-shaped endpoint is left alone');
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'zai', 'models']);
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
