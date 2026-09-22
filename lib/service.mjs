// lib/service.mjs — the host-side refresh: models.dev catalog → provider settings.
//
// One refresh walk covers "everything that is hooked up": the configurable-
// provider directory rows ctx.llm already serves. This plugin keeps the pi-ai
// family rows current (the model shape it writes is llm-pi-ai's `models` entry;
// other adapters declare different shapes and are left alone), maps each route
// to its models.dev provider (the route key by default, `sources` overrides),
// merges the catalog into the row's `models` array and writes it back with path
// ops and the revision the row was read at. A refused write is reported for
// that route and the sweep continues.
import { entryFromModel, mergeModels } from './caps.mjs';

/** The settings namespace whose provider profiles this plugin keeps current. */
export const TARGET_NS = 'llm-pi-ai';

/** Read one path inside a settings layer; undefined when the path is absent. */
function readAt(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** The `models` entries of one layer value: objects carrying a non-empty id. */
function modelsArrayOf(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.id === 'string' && item.id.length > 0,
  );
}

/**
 * Refresh the model catalog of every hooked-up pi-ai route from one models.dev
 * read. Rows the user layer declares win over the resolved layer for the merge
 * base, exactly like the Models page's capability editor.
 *
 * @param options.settings - the host settings seam (describe/mutate).
 * @param options.providers - the configurable-provider directory rows.
 * @param options.catalog - one models.dev api.json payload, keyed by provider id.
 * @param options.sources - optional route → models.dev provider id overrides.
 * @returns one result per targeted row: {route, source, added, updated} on
 *   success, or {route, source, skipped|error} with the reason.
 */
export async function syncRoutes({ settings, providers, catalog, sources = {} }) {
  const results = [];
  const views = new Map((settings.describe() ?? []).map((view) => [view.ns, view]));
  for (const row of providers ?? []) {
    if (row?.settingsNs !== TARGET_NS || typeof row.provider !== 'string') continue;
    const route = row.provider;
    const source = sources[route] ?? route;
    const providerData = catalog?.[source];
    if (providerData === undefined || providerData === null) {
      results.push({ route, source, skipped: 'no-catalog-source' });
      continue;
    }
    const view = views.get(row.settingsNs);
    if (view === undefined) {
      results.push({ route, source, skipped: 'namespace-not-registered' });
      continue;
    }
    const modelsPath = [...(row.settingsPath ?? []), 'models'];
    const current =
      modelsArrayOf(readAt(view.user, modelsPath)) ??
      modelsArrayOf(readAt(view.value, modelsPath)) ??
      [];
    const catalogEntries = Object.values(providerData.models ?? {}).map(entryFromModel);
    const { entries, added, updated } = mergeModels(current, catalogEntries);
    try {
      await settings.mutate(row.settingsNs, [{ op: 'set', path: modelsPath, value: entries }], view.revision);
    } catch (error) {
      results.push({ route, source, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    results.push({ route, source, added, updated });
  }
  return results;
}
