// test/map.test.mjs — pure mapping tests against a models.dev-shaped fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEffortThinkingLevelMap, mapModels } from '../lib/map.mjs';

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
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'high', 'max'] },
        ],
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, output: 65536 },
        cost: { input: 0.6, output: 1.9, cache_read: 0.119 },
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

// ─── thinking levels (models.dev reasoning_options → pi-ai thinkingLevelMap) ───

test('effort values become a full level map with unsupported levels pinned to null', () => {
  assert.deepEqual(getEffortThinkingLevelMap([{ type: 'effort', values: ['low', 'medium', 'high'] }]), {
    off: null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  });
});

test('a "none" effort becomes the off level; every other value maps 1:1', () => {
  assert.deepEqual(getEffortThinkingLevelMap([{ type: 'effort', values: ['none', 'high', 'max'] }]), {
    off: 'none',
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });
});

test('values without a pi level ("default", null) are ignored, not turned into levels', () => {
  assert.deepEqual(getEffortThinkingLevelMap([{ type: 'effort', values: ['default', null, 'xhigh'] }]), {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: 'xhigh',
    max: null,
  });
  assert.equal(getEffortThinkingLevelMap([{ type: 'effort', values: ['default', null] }]), undefined);
});

test('budget_tokens- and toggle-only models publish no level map', () => {
  assert.equal(getEffortThinkingLevelMap([{ type: 'budget_tokens', min: 1024, max: 32768 }]), undefined);
  assert.equal(getEffortThinkingLevelMap([{ type: 'toggle' }]), undefined);
  assert.equal(getEffortThinkingLevelMap([]), undefined);
  assert.equal(getEffortThinkingLevelMap(undefined), undefined);
});

test('a mixed option list reads only its effort entry', () => {
  assert.deepEqual(
    getEffortThinkingLevelMap([{ type: 'toggle' }, { type: 'budget_tokens', min: 1024 }, { type: 'effort', values: ['minimal', 'high'] }]),
    { off: null, minimal: 'minimal', low: null, medium: null, high: 'high', xhigh: null, max: null },
  );
});

test('mapped models carry the level map; models without effort options carry no field at all', () => {
  const { models } = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go']);
  const glm = models.find((m) => m.id === 'glm-5.3');
  assert.ok(glm, 'glm-5.3 is mapped');
  assert.deepEqual(glm.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });
  const mimo = models.find((m) => m.id === 'mimo-v2.6-pro');
  assert.equal('thinkingLevelMap' in mimo, false);
});

test('a configured thinkingLevelMap replaces the mapped one, and false strips it', () => {
  const replaced = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go'], {
    models: [{ id: 'glm-5.3', thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
  });
  assert.deepEqual(replaced.models[0].thinkingLevelMap, { off: null, low: 'low', medium: 'medium', high: 'high' });

  const stripped = mapModels('opencode-go', 'opencode-go', FIXTURE['opencode-go'], {
    models: [{ id: 'glm-5.3', thinkingLevelMap: false }],
  });
  assert.equal('thinkingLevelMap' in stripped.models[0], false);
});

