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
import { entryFromModel, mergeModels, wireProfile } from './caps.mjs';

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
 * base, exactly like the Models page's capability editor. Only routes that are
 * actually hooked up (their profile resolves in the namespace) are touched — a
 * declared-but-unconfigured provider is not "podpięte", and materializing model
 * rows for it would bloat the settings document (and exotic adapters refuse
 * such writes anyway). Each write re-reads the namespace first: the routes share
 * one namespace and every write bumps its revision, so fencing a whole sweep
 * against one stale read would reject everything after the first write.
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
  for (const row of providers ?? []) {
    if (row?.settingsNs !== TARGET_NS || typeof row.provider !== 'string') continue;
    const route = row.provider;
    const source = sources[route] ?? route;
    const view = (settings.describe() ?? []).find((candidate) => candidate.ns === row.settingsNs);
    if (view === undefined) {
      results.push({ route, source, skipped: 'namespace-not-registered' });
      continue;
    }
    const modelsPath = [...(row.settingsPath ?? []), 'models'];
    if (readAt(view.value, row.settingsPath ?? []) === undefined) {
      results.push({ route, source, skipped: 'not-configured' });
      continue;
    }
    const providerData = catalog?.[source];
    if (providerData === undefined || providerData === null) {
      results.push({ route, source, skipped: 'no-catalog-source' });
      continue;
    }
    const current =
      modelsArrayOf(readAt(view.user, modelsPath)) ??
      modelsArrayOf(readAt(view.value, modelsPath)) ??
      [];
    const catalogEntries = Object.values(providerData.models ?? {}).map(entryFromModel);
    const { entries, added, updated } = mergeModels(current, catalogEntries);
    const ops = [{ op: 'set', path: modelsPath, value: entries }];
    // Models the installed catalog does not describe resolve their api and base
    // URL off the route profile (llm-pi-ai refuses them without), so a route
    // that names neither gets the wire profile its models.dev record speaks —
    // never overriding what the user set.
    const wire = wireProfile(providerData);
    const routePath = row.settingsPath ?? [];
    for (const [field, value] of [['api', wire.api], ['baseURL', wire.baseURL]]) {
      const path = [...routePath, field];
      if (value !== undefined && readAt(view.value, path) === undefined) ops.push({ op: 'set', path, value });
    }
    try {
      await settings.mutate(row.settingsNs, ops, view.revision);
    } catch (error) {
      results.push({
        route,
        source,
        error: error instanceof Error ? error.message : String(error),
        // The error notification shows the refusal where it happened.
        stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      continue;
    }
    results.push({ route, source, added, updated });
  }
  return results;
}
