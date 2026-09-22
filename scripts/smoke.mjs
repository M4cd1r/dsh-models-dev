// scripts/smoke.mjs — end-to-end sanity: fixture mapping plus a best-effort live
// check against https://models.dev/api.json (network optional).
import assert from 'node:assert/strict';
import { getEffortThinkingLevelMap, mapModels } from '../lib/map.mjs';

const fixture = {
  id: 'opencode-go',
  npm: '@ai-sdk/openai-compatible',
  api: 'https://opencode.ai/zen/go/v1',
  models: {
    'mimo-v2.6-pro': {
      id: 'mimo-v2.6-pro',
      name: 'MiMo-V2.6-Pro',
      tool_call: true,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1048576, output: 131072 },
      cost: { input: 0.435, output: 0.87, cache_read: 0.003625 },
    },
  },
};

const local = mapModels('opencode-go', 'opencode-go', fixture).models[0];
assert.equal(local.api, 'openai-completions');
assert.equal(local.baseUrl, 'https://opencode.ai/zen/go/v1');
assert.equal('thinkingLevelMap' in local, false, 'a model with no effort options publishes no level map');
assert.deepEqual(getEffortThinkingLevelMap([{ type: 'effort', values: ['none', 'high'] }]), {
  off: 'none',
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: null,
  max: null,
});
console.log(`smoke: fixture maps mimo-v2.6-pro -> ${local.api} @ ${local.baseUrl} (no effort metadata, no level map)`);

let data;
try {
  const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) });
  data = await response.json();
} catch (error) {
  console.log(`smoke: live check skipped (${error?.message ?? error})`);
}

if (data !== undefined) {
  const source = data['opencode-go'];
  const { models } = mapModels('opencode-go', 'opencode-go', source);
  const pro = models.find((model) => model.id === 'mimo-v2.6-pro');
  assert.ok(pro, 'live models.dev lists mimo-v2.6-pro on opencode-go');
  assert.equal(pro.api, 'openai-completions');

  // Every level models.dev declares effort for must arrive selectable and
  // identity-mapped, and every level it omits must be pinned unsupported. The
  // expectation is re-derived here from the raw catalog, not reused from map.mjs.
  const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const withLevels = models.filter((model) => model.thinkingLevelMap !== undefined);
  assert.ok(withLevels.length > 0, 'live models.dev declares effort levels for opencode-go models');
  for (const model of withLevels) {
    const declared = new Set(
      (source.models[model.id].reasoning_options ?? []).flatMap((option) => (option.type === 'effort' ? option.values : [])),
    );
    assert.deepEqual(
      Object.keys(model.thinkingLevelMap).sort(),
      ['off', ...LEVELS].sort(),
      `${model.id} publishes every level key`,
    );
    assert.equal(model.thinkingLevelMap.off, declared.has('none') ? 'none' : null, `${model.id} off`);
    for (const level of LEVELS) {
      assert.equal(model.thinkingLevelMap[level], declared.has(level) ? level : null, `${model.id} ${level}`);
    }
  }
  assert.equal('thinkingLevelMap' in pro, false, 'mimo-v2.6-pro declares no effort levels');

  console.log(
    `smoke: live models.dev maps ${models.length} opencode-go models, ${withLevels.length} with verified thinking levels`,
  );
}

console.log('smoke: OK');
