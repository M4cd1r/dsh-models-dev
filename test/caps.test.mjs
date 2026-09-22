// test/caps.test.mjs — models.dev → settings model-capability entries.
//
// RED baseline (2026-09-22): the provider catalogs in settings.yaml carry
// hand-made rows whose modalities and thinking levels are stale or undeclared,
// and missing models (mimo-v2.6-pro) are absent altogether. The refresh must
// rebuild the `models` array for one provider from the live catalog: new models
// appended, existing models updated in place (modalities + thinking levels),
// hand-added models models.dev does not know kept untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryFromModel, effortsFromModel, mergeModels, wireProfile } from '../lib/caps.mjs';

/** A models.dev model record, as found under providers[id].models[modelId]. */
const model = (overrides = {}) => ({
  id: 'mimo-v2.6-pro',
  name: 'MiMo-V2.6-Pro',
  tool_call: true,
  reasoning: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 1048576, output: 131072 },
  cost: { input: 0.435, output: 0.87, cache_read: 0.003625 },
  ...overrides,
});

test('effortsFromModel maps effort values to a reasoningEfforts dict', () => {
  const efforts = effortsFromModel(model({ reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }] }));
  assert.deepEqual(efforts, { off: 'none', low: 'low', high: 'high' });
});

test('effortsFromModel drops values outside the thinking levels', () => {
  const efforts = effortsFromModel(model({ reasoning_options: [{ type: 'effort', values: ['low', 'ultra', 'medium'] }] }));
  assert.deepEqual(efforts, { low: 'low', medium: 'medium' });
});

test('effortsFromModel turns a none-only model into non-reasoning', () => {
  assert.equal(effortsFromModel(model({ reasoning_options: [{ type: 'effort', values: ['none'] }] })), false);
});

test('effortsFromModel maps a non-reasoning model to false', () => {
  assert.equal(effortsFromModel(model({ reasoning: false })), false);
});

test('effortsFromModel stays silent for a reasoning model that names no levels', () => {
  assert.equal(effortsFromModel(model()), undefined);
  assert.equal(effortsFromModel(model({ reasoning_options: [{ type: 'toggle' }] })), undefined);
});

test('entryFromModel builds a full capability entry', () => {
  const entry = entryFromModel(model({ reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }));
  assert.deepEqual(entry, {
    id: 'mimo-v2.6-pro',
    name: 'MiMo-V2.6-Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high' },
  });
});

test('entryFromModel declares text-only input for a text model', () => {
  const entry = entryFromModel(model({ modalities: { input: ['text'], output: ['text'] } }));
  assert.deepEqual(entry.input, ['text']);
});

test('entryFromModel omits limits models.dev does not publish', () => {
  const entry = entryFromModel(model({ limit: undefined }));
  assert.equal('contextWindow' in entry, false);
  assert.equal('maxTokens' in entry, false);
});

test('entryFromModel refuses models an agent cannot drive', () => {
  assert.equal(entryFromModel(model({ tool_call: false })), null);
  assert.equal(entryFromModel(model({ tool_call: undefined })), null);
  assert.equal(entryFromModel(model({ status: 'deprecated' })), null);
});

test('mergeModels appends models the catalog adds', () => {
  const { entries, added, updated } = mergeModels([], [entryFromModel(model())]);
  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'mimo-v2.6-pro');
});

test('mergeModels updates capabilities of models that already exist', () => {
  const existing = [{ id: 'mimo-v2.6-pro', name: 'Hand name', maxTokens: 65536 }];
  const { entries, added, updated } = mergeModels(existing, [entryFromModel(model({ reasoning_options: [{ type: 'effort', values: ['high'] }] }))]);
  assert.equal(added, 0);
  assert.equal(updated, 1);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 'mimo-v2.6-pro',
    name: 'Hand name',
    maxTokens: 65536,
    contextWindow: 1048576,
    input: ['text', 'image'],
    reasoningEfforts: { high: 'high' },
  });
});

test('mergeModels keeps hand-added models the catalog does not know', () => {
  const existing = [{ id: 'my-custom', name: 'Custom', input: ['text'] }];
  const { entries, added, updated } = mergeModels(existing, [entryFromModel(model())]);
  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.deepEqual(entries[0], { id: 'my-custom', name: 'Custom', input: ['text'] });
});

test('mergeModels keeps capabilities the catalog stays silent about', () => {
  const existing = [{ id: 'mimo-v2.6-pro', reasoningEfforts: { low: 'low' }, input: ['text'] }];
  const { entries, updated } = mergeModels(existing, [entryFromModel(model({ reasoning_options: undefined }))]);
  assert.equal(updated, 1);
  assert.deepEqual(entries[0].reasoningEfforts, { low: 'low' });
  assert.deepEqual(entries[0].input, ['text', 'image']);
});

test('wireProfile maps the models.dev package to protocol and endpoint', () => {
  assert.deepEqual(wireProfile({ npm: '@ai-sdk/anthropic', api: 'https://api.anthropic.com/v1' }), {
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
  });
  assert.deepEqual(wireProfile({ npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1' }), {
    api: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
  });
  assert.deepEqual(wireProfile({ npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/zen/go/v1' }), {
    api: 'openai-completions',
    baseURL: 'https://opencode.ai/zen/go/v1',
  });
  assert.deepEqual(wireProfile({}), { api: 'openai-completions', baseURL: undefined });
});
