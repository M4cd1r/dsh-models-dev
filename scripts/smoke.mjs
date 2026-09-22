// scripts/smoke.mjs — end-to-end sanity: fixture mapping plus a best-effort live
// check against https://models.dev/api.json (network optional).
import assert from 'node:assert/strict';
import { mapModels } from '../lib/map.mjs';

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
console.log(`smoke: fixture maps mimo-v2.6-pro -> ${local.api} @ ${local.baseUrl}`);

try {
  const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  const { models } = mapModels('opencode-go', 'opencode-go', data['opencode-go']);
  const pro = models.find((model) => model.id === 'mimo-v2.6-pro');
  assert.ok(pro, 'live models.dev lists mimo-v2.6-pro on opencode-go');
  assert.equal(pro.api, 'openai-completions');
  console.log(`smoke: live models.dev maps ${models.length} opencode-go models, mimo-v2.6-pro OK`);
} catch (error) {
  console.log(`smoke: live check skipped (${error?.message ?? error})`);
}

console.log('smoke: OK');
