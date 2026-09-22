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
//
// The route's `api`/`baseURL` (its wire endpoint) are treated far more
// conservatively than the model rows, because they decide where a call is
// dispatched — and which bill it lands on. llm-pi-ai resolves those fields in
// layers (`request.api ?? base?.api ?? sharedCatalogApi(...)`, likewise the
// base URL), so a field the settings layer does not carry is usually NOT
// missing — its installed catalog already resolves it. An earlier version of
// this plugin filled every absent field from the models.dev record, and that
// pin silently shadowed the working resolution whenever the same-named
// models.dev provider spoke a different flavor than the route (models.dev's
// `zai` is the Z.AI open platform while pi-ai's `zai` route is the Z.AI Coding
// Plan: pinning the open-platform endpoint turned every call into
// 429 "Insufficient balance or no resource package"). Now the wire profile is
// written only when llm-pi-ai's strict validation refuses the models write
// without it ("... needs an api ... set the route's ..."), and a pin an earlier
// version left behind is repaired when `sources` maps the route to the models.dev
// provider the user actually subscribes to.
import { entryFromModel, mergeModels, wireProfile } from './caps.mjs';

/** The settings namespace whose provider profiles this plugin keeps current. */
export const TARGET_NS = 'llm-pi-ai';

/** The route profile fields that pin one wire endpoint. */
const WIRE_FIELDS = ['api', 'baseURL'];

/** llm-pi-ai's strict refusals for a model that resolves no wire profile. */
const NEEDS_API = /needs an api\b/;
const NEEDS_BASE_URL = /needs a baseURL\b/;

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
 * Wire profile (`api`/`baseURL`) rules, in order:
 *   - an absent field is left absent — llm-pi-ai's installed catalog may resolve
 *     it, and a fill would pin the models.dev endpoint over that resolution;
 *   - a field the strict validation refuses the write without ("needs an
 *     api"/"needs a baseURL") gets the mapped source's wire value filled —
 *     llm-pi-ai's own prescription for a route no catalog describes;
 *   - a present field equal to the wire profile of the route-key mapping (the
 *     shape earlier plugin versions filled blindly) is repaired to the mapped
 *     source's profile when they differ — the `sources` remap is an explicit
 *     statement of which flavor the route subscribes to;
 *   - every other present field is user-owned and never touched.
 *
 * @param options.settings - the host settings seam (describe/mutate).
 * @param options.providers - the configurable-provider directory rows.
 * @param options.catalog - one models.dev api.json payload, keyed by provider id.
 * @param options.sources - optional route → models.dev provider id overrides.
 * @returns one result per targeted row: {route, source, added, updated} on
 *   success (with `filled`/`repaired` field names when the wire profile was
 *   touched), or {route, source, skipped|error} with the reason.
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
    const routePath = row.settingsPath ?? [];
    const modelsPath = [...routePath, 'models'];
    if (readAt(view.value, routePath) === undefined) {
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

    // The wire profile: fill nothing eagerly. Absent fields ride the deferred
    // list (filled only if the strict validation refuses without them); a value
    // shaped exactly like the route-key mapping's profile is a pin earlier
    // versions wrote and is kept in sync with the mapping the config declares.
    const wire = wireProfile(providerData);
    const defaultWire = wireProfile(catalog?.[route]);
    const deferred = [];
    const repaired = [];
    for (const field of WIRE_FIELDS) {
      const value = wire[field];
      if (value === undefined) continue;
      const path = [...routePath, field];
      const at = readAt(view.value, path);
      if (at === undefined) {
        deferred.push({ field, path, value });
        continue;
      }
      if (at === defaultWire[field] && value !== at) {
        ops.push({ op: 'set', path, value });
        repaired.push(field);
      }
    }

    // The write loop: models first, wire fills one at a time — llm-pi-ai's
    // strict validation is the oracle for whether the route profile needs them.
    // Every attempt re-reads the namespace for a fresh revision (the routes
    // share one, and any successful write bumps it).
    const filled = [];
    let result;
    for (let attempt = 0; ; attempt += 1) {
      const fresh = (settings.describe() ?? []).find((candidate) => candidate.ns === row.settingsNs) ?? view;
      try {
        await settings.mutate(row.settingsNs, ops, fresh.revision);
        result = { route, source, added, updated };
        break;
      } catch (error) {
        const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        const field = NEEDS_API.test(text) ? 'api' : NEEDS_BASE_URL.test(text) ? 'baseURL' : undefined;
        const fill =
          field === undefined ? undefined : deferred.find((candidate) => candidate.field === field && !filled.includes(field));
        if (fill === undefined) {
          result = {
            route,
            source,
            error: error instanceof Error ? error.message : String(error),
            // The error notification shows the refusal where it happened.
            stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
          };
          break;
        }
        ops.push({ op: 'set', path: fill.path, value: fill.value });
        filled.push(fill.field);
      }
    }
    if (filled.length > 0) result.filled = filled;
    if (repaired.length > 0) result.repaired = repaired;
    results.push(result);
  }
  return results;
}
