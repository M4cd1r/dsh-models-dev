// scripts/smoke.mjs — fixture mapping plus a best-effort live check.
//
// The fixture pins the mapping contract (modalities → `input`, effort values →
// `reasoningEfforts`); the live check re-derives the expectations straight from
// https://models.dev/api.json so the two can never drift apart quietly.
import assert from 'node:assert/strict';
import { entryFromModel, mergeModels } from '../lib/caps.mjs';

const fixture = {
  id: 'mimo-v2.6-pro',
  name: 'MiMo-V2.6-Pro',
  tool_call: true,
  reasoning: true,
  reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 1048576, output: 131072 },
};

const local = entryFromModel(fixture);
assert.deepEqual(local.input, ['text', 'image']);
assert.deepEqual(local.reasoningEfforts, { off: 'none', low: 'low', high: 'high' });
const merged = mergeModels([{ id: 'mimo-v2.6-pro', name: 'Hand' }], [local]);
assert.equal(merged.updated, 1);
assert.equal(merged.entries[0].name, 'Hand', 'hand-set fields survive a refresh');
console.log('smoke: fixture maps mimo-v2.6-pro -> input text+image, thinking none/low/high (hand name kept)');

let data;
try {
  const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) });
  data = await response.json();
} catch (error) {
  console.log(`smoke: live check skipped (${error?.message ?? error})`);
}

if (data !== undefined) {
  const raw = data['opencode-go']?.models ?? {};
  const entries = Object.values(raw).map(entryFromModel).filter((entry) => entry !== null);
  const pro = entries.find((entry) => entry.id === 'mimo-v2.6-pro');
  assert.ok(pro, 'live models.dev lists mimo-v2.6-pro for opencode-go');
  assert.deepEqual(pro.input, ['text', 'image'], 'mimo-v2.6-pro accepts images');

  // Every capability is re-derived from the raw catalog, not reused from caps.mjs.
  const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let withEfforts = 0;
  for (const entry of entries) {
    const source = raw[entry.id];
    const expectsImage = (source.modalities?.input ?? []).includes('image');
    assert.deepEqual(entry.input, expectsImage ? ['text', 'image'] : ['text'], `${entry.id} modalities`);
    const values = (source.reasoning_options ?? [])
      .filter((option) => option.type === 'effort')
      .flatMap((option) => option.values ?? []);
    const levels = values.filter((value) => value === 'none' || LEVELS.includes(value));
    if (levels.length === 0 || levels.every((value) => value === 'none')) {
      assert.ok(entry.reasoningEfforts === undefined || entry.reasoningEfforts === false, `${entry.id} declares no thinking levels`);
    } else {
      withEfforts += 1;
      assert.deepEqual(
        Object.keys(entry.reasoningEfforts).sort(),
        levels.map((value) => (value === 'none' ? 'off' : value)).sort(),
        `${entry.id} thinking levels`,
      );
    }
  }
  assert.ok(withEfforts > 0, 'live models.dev declares thinking levels for some opencode-go models');
  console.log(`smoke: live models.dev serves ${entries.length} opencode-go models, ${withEfforts} with thinking levels`);
}

console.log('smoke: OK');
