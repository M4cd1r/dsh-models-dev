// test/map.test.mjs — pure mapping tests against a models.dev-shaped fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapModels } from '../lib/map.mjs';

const FIXTURE = {
  'opencode-go': {
    id: 'opencode-go',
    env: 'OPENCODE_API_KEY',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/go/v1',
    name: 'OpenCode Go',
    models: {
      'mimo-v2.6-pro': {
        id: 'mimo-v2.6-pro',
        name: 'MiMo-V2.6-Pro',
        tool_call: true,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
        limit: { context: 1048576, output: 131072 },
        cost: { input: 0.435, output: 0.87, cache_read: 0.003625 },
      },
      'minimax-m3': {
        id: 'minimax-m3',
        name: 'MiniMax-M3',
        tool_call: true,
        reasoning: true,
        provider: { npm: '@ai-sdk/anthropic' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 131072 },
        cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
      },
      'text-only-model': { id: 'text-only-model', tool_call: false },
      'old-model': { id: 'old-model', tool_call: true, status: 'deprecated' },
    },
  },
};

test('openai-compatible model maps to openai-completions with the published base', () => {
  const { models, errors } = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go']);
  const model = models.find((m) => m.id === 'mimo-v2.6-pro');
  assert.ok(model, 'mimo-v2.6-pro is mapped');
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 131072);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.reasoning, true);
  assert.equal(model.cost.input, 0.435);
  assert.equal(model.cost.cacheRead, 0.003625);
  assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(errors.size, 0);
});

test('per-model anthropic npm override maps protocol and strips /v1 from the base', () => {
  const { models } = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go']);
  const model = models.find((m) => m.id === 'minimax-m3');
  assert.ok(model, 'minimax-m3 is mapped');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'https://opencode.ai/zen/go');
  assert.equal(model.compat, undefined);
});

test('tool-call-less and deprecated models are skipped silently unless requested', () => {
  const { models, errors } = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go']);
  assert.ok(!models.some((m) => m.id === 'text-only-model'));
  assert.ok(!models.some((m) => m.id === 'old-model'));
  assert.equal(errors.size, 0);
});

test('a models list filters the served set and applies overrides', () => {
  const { models, configuredMaxTokens, errors } = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go'], {
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo 2.6 Pro (custom)', maxTokens: 65536 },
      { id: 'ghost-model' },
      { id: 'text-only-model' },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ['mimo-v2.6-pro']);
  assert.equal(models[0].name, 'MiMo 2.6 Pro (custom)');
  assert.equal(models[0].maxTokens, 65536);
  assert.equal(configuredMaxTokens.get('mimo-v2.6-pro'), 65536);
  assert.match(errors.get('ghost-model') ?? '', /does not list/);
  assert.match(errors.get('text-only-model') ?? '', /tool-capable/);
});

test('route-level api and baseURL force every model', () => {
  const { models } = mapModels('custom', 'opencode-go', FIXTURE['opencode-go'], {
    api: 'openai-completions',
    baseURL: 'https://proxy.internal/v1',
    models: [{ id: 'minimax-m3' }],
  });
  assert.equal(models[0].api, 'openai-completions');
  assert.equal(models[0].baseUrl, 'https://proxy.internal/v1');
});

test('unknown provider produces a route-level error', () => {
  const { models, errors } = mapModels('nope', 'does-not-exist', undefined);
  assert.equal(models.length, 0);
  assert.match(errors.get('nope') ?? '', /has no provider/);
});
