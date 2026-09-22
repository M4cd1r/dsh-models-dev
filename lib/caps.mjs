// lib/caps.mjs — models.dev model records → llm-pi-ai settings capability entries.
//
// The Models page edits `providers.<route>.models[]` entries shaped
// {id, name, contextWindow, maxTokens, input, reasoningEfforts} (see the
// dsh-llm-pi-ai profile schema): `input` declares modalities (the image-input
// checkbox is `input.includes("image")`), `reasoningEfforts` declares the
// thinking levels with their wire spellings. This module turns one models.dev
// model record into such an entry and merges a catalog refresh into the rows a
// user already has — updating capabilities in place, appending new models, and
// never touching hand-added rows the catalog does not describe.

/** The thinking levels a profile may declare (escalation order includes `off`). */
const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Levels that carry a wire value; `off` is special (see effortsFromModel). */
const WIRE_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** The effort values a models.dev model's `reasoning_options` declares. */
function effortValues(model) {
  const options = model?.reasoning_options;
  if (!Array.isArray(options)) return [];
  return options
    .filter((option) => option?.type === 'effort')
    .flatMap((option) => (Array.isArray(option.values) ? option.values : []));
}

/**
 * One model's `reasoningEfforts` declaration.
 *
 * Effort values are the wire spellings the endpoint accepts: `none` lands on
 * the `off` level so choosing "off" sends the endpoint's own no-thinking value,
 * every other known level maps to itself. A model whose only declared value is
 * `none` offers nothing to think with and reads as non-reasoning (`false`); a
 * model that names no effort values returns `undefined`, which keeps the
 * installed catalog's capability (or none, for a hand-added row).
 *
 * @param model - one models.dev model record.
 * @returns the declaration, `false` for non-reasoning, or `undefined` to inherit.
 */
export function effortsFromModel(model) {
  if (model?.reasoning === false) return false;
  const declared = effortValues(model).filter((value) => value === 'none' || WIRE_LEVELS.has(value));
  if (declared.length === 0) return undefined;
  const efforts = {};
  for (const value of declared) {
    if (value === 'none') efforts.off = value;
    else efforts[value] = value;
  }
  return Object.keys(efforts).some((level) => level !== 'off') ? efforts : false;
}

/**
 * One models.dev model as a settings `models` entry, or null when the model is
 * not something an agent should drive (no tool calls, or deprecated).
 *
 * @param model - one models.dev model record.
 * @returns the entry, or null when the model is skipped.
 */
export function entryFromModel(model) {
  if (model === null || typeof model !== 'object') return null;
  if (typeof model.id !== 'string' || model.id.length === 0) return null;
  if (model.tool_call !== true || model.status === 'deprecated') return null;
  const entry = {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
  };
  if (typeof model.limit?.context === 'number') entry.contextWindow = model.limit.context;
  if (typeof model.limit?.output === 'number') entry.maxTokens = model.limit.output;
  const declaredInput = Array.isArray(model.modalities?.input) ? model.modalities.input : undefined;
  if (declaredInput !== undefined) entry.input = declaredInput.includes('image') ? ['text', 'image'] : ['text'];
  const efforts = effortsFromModel(model);
  if (efforts !== undefined) entry.reasoningEfforts = efforts;
  return entry;
}

/**
 * Merge one catalog refresh into the rows a provider already declares.
 *
 * Catalog models the rows lack are appended whole; catalog models the rows
 * already carry get their capabilities refreshed (modalities and thinking
 * levels) while hand-set fields — names, limits, anything unknown — survive.
 * Capabilities the catalog stays silent about keep their hand-declared value.
 * Rows the catalog does not describe are left alone.
 *
 * @param existing - the provider's current `models` entries.
 * @param catalog - entries built by entryFromModel (nulls dropped).
 * @returns the next entries with `added`/`updated` counts for reporting.
 */
export function mergeModels(existing, catalog) {
  const entries = (Array.isArray(existing) ? existing : []).map((entry) => ({ ...entry }));
  const index = new Map(entries.map((entry, position) => [entry.id, position]));
  let added = 0;
  let updated = 0;
  for (const next of catalog) {
    if (next === null) continue;
    const at = index.get(next.id);
    if (at === undefined) {
      index.set(next.id, entries.length);
      entries.push({ ...next });
      added += 1;
      continue;
    }
    const merged = { ...entries[at] };
    if (next.input !== undefined) merged.input = next.input;
    if (next.reasoningEfforts !== undefined) merged.reasoningEfforts = next.reasoningEfforts;
    if (merged.name === undefined && next.name !== undefined) merged.name = next.name;
    if (merged.contextWindow === undefined && next.contextWindow !== undefined) merged.contextWindow = next.contextWindow;
    if (merged.maxTokens === undefined && next.maxTokens !== undefined) merged.maxTokens = next.maxTokens;
    entries[at] = merged;
    updated += 1;
  }
  return { entries, added, updated };
}

/** The levels a reasoningEfforts declaration may name (diagnostics and guards). */
export const THINKING_LEVELS = [...LEVELS];
