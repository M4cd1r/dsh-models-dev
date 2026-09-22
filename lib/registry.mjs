// registry.mjs — build pi-ai-backed routes from the live models.dev catalog and
// register them through the dsh LLM seam (ctx.llm), alongside or instead of the
// llm-pi-ai routes.
//
// Each configured route becomes a ResolvedPiAiProviderProfile-shaped record
// whose models come from this plugin's own mapping (lib/map.mjs) — never from
// pi-ai's vendored catalog — and a single shared PiAiAdapter serves them all.
// Class identity matters across the seam, so every host type (PiAiAdapter,
// createProvider, LlmError, …) arrives through lib/runtime.mjs from the running
// dsh's own module instances.

import { mapModels } from './map.mjs';

const NS = 'dsh-models-dev';
const STREAM_IDLE_TIMEOUT_MS = 300000;
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
const REQUEST_IMAGE_MAX_BYTES = 1048576;

/**
 * Build the route registry bound to one ctx.
 * @param ctx - the cordis plugin context (needs ctx.llm, optional ctx.get('credentials')/('attachments')).
 * @param mods - host modules from loadHostModules().
 * @returns {{update(sources: object, catalog: object): void, dispose(): void}}
 */
export function createRegistry(ctx, mods) {
  const { piAi, llmPiAi, dshLlm, credentials, launchEnvironment, anthropicApi, completionsApi, responsesApi } = mods;

  const apiTable = {
    'anthropic-messages': anthropicApi.anthropicMessagesApi(),
    'openai-completions': completionsApi.openAICompletionsApi(),
    'openai-responses': responsesApi.openAIResponsesApi(),
  };

  const resolveApiKey = async (provider, profile) => {
    const ref = profile.apiKeyEnv;
    if (ref === undefined) return undefined;
    const store = ctx.get?.('credentials');
    const hit =
      store !== undefined && credentials.isCredentialRefName(ref)
        ? (await store.resolve(credentials.credentialRef(ref)))?.value
        : (store !== undefined ? (await store.resolve(ref))?.value : undefined) ?? launchEnvironment.launchEnvironmentOf(ctx).get(ref)?.value;
    if (hit !== undefined && hit.length > 0) return dshLlm.assertUsableApiKey(hit, NS, ref);
    throw new dshLlm.LlmError(
      `${NS}: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} ` +
        `through the credentials service (the web Models page writes it) or export it`,
      'MISSING_CREDENTIAL',
    );
  };

  // Our routes authenticate through resolveApiKey (request-level override, the
  // highest priority in pi-ai), so pi-ai's own credential storage stays empty
  // by construction — the same posture llm-pi-ai documents for API-key routes.
  const auth = {
    credentials: new piAi.InMemoryCredentialStore(),
    authContext: piAi.defaultProviderAuthContext(),
  };

  const state = {
    profiles: new Map(),
    adapter: undefined,
    registration: undefined,
    registrationFacts: undefined,
    directory: undefined,
    directoryFacts: undefined,
    catalog: {},
  };

  state.adapter = new llmPiAi.PiAiAdapter({
    profiles: () => state.profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get?.('attachments'),
  });

  function buildProfiles(sources, catalog) {
    const profiles = new Map();
    for (const [routeKey, route] of Object.entries(sources ?? {})) {
      const displayName = route.displayName ?? routeKey;
      const source = route.source ?? routeKey;
      const mapped = mapModels(routeKey, source, catalog?.[source], route);
      const piProvider = piAi.createProvider({
        id: routeKey,
        name: displayName,
        auth: { apiKey: piAi.envApiKeyAuth(displayName, [route.apiKeyEnv ?? routeKey]) },
        models: mapped.models,
        api: apiTable,
      });
      profiles.set(routeKey, {
        provider: routeKey,
        displayName,
        apiKeyEnv: route.apiKeyEnv,
        piProvider: mapped.models.length > 0 ? piProvider : undefined,
        catalogError: mapped.models.length > 0 ? undefined : (mapped.errors.values().next().value ?? `${NS}: route "${routeKey}" resolved no models`),
        modelErrors: mapped.errors,
        configuredMaxTokens: mapped.configuredMaxTokens,
        retryPolicy: dshLlm.resolveRetryPolicy(undefined, `${NS}.providers.${routeKey}.retryPolicy`),
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
      });
    }
    return profiles;
  }

  function directoryEntries() {
    return [...state.profiles.values()].map((profile) => ({
      provider: profile.provider,
      displayName: profile.displayName,
      settingsNs: NS,
      settingsPath: ['providers', profile.provider],
      declared: true,
      ...(profile.catalogError === undefined ? {} : { error: profile.catalogError }),
    }));
  }

  function ensureDirectory() {
    const entries = directoryEntries();
    const facts = JSON.stringify(entries);
    if (facts === state.directoryFacts) return;
    if (entries.length === 0) {
      // The seam refuses an empty configurable-provider registration by design,
      // and a deployment may legitimately configure no routes at all (or reach
      // this before the settings source is live). Withdraw ours instead of
      // throwing: the bootstrap must survive a catalog that maps nothing.
      try {
        state.directory?.();
      } catch {
        // older handles may not be callable as disposers; nothing to do
      }
      state.directory = undefined;
      state.directoryFacts = facts;
      return;
    }
    if (state.directory === undefined) state.directory = ctx.llm.registerConfigurableProviders(entries);
    else state.directory.replace(entries);
    state.directoryFacts = facts;
  }

  function ensureRegistration() {
    const routes = [...state.profiles.keys()].sort();
    const facts = JSON.stringify(routes.map((route) => [route, state.profiles.get(route).displayName, state.profiles.get(route).retryPolicy]));
    if (facts === state.registrationFacts) return;
    if (state.registration === undefined) {
      if (routes.length === 0) {
        state.registrationFacts = facts;
        return;
      }
      try {
        state.registration = ctx.llm.registerAdapter(routes, state.adapter);
      } catch (error) {
        ctx.logger?.error?.(
          `${NS}: route registration refused — a route key may already be taken (e.g. by llm-pi-ai); remove it there to replace it, or pick another key to coexist`,
        );
        ctx.logger?.error?.(error);
        return;
      }
    } else {
      try {
        state.registration.replace(routes);
      } catch (error) {
        ctx.logger?.error?.(`${NS}: could not replace the registered routes; keeping the previous set`);
        ctx.logger?.error?.(error);
        return;
      }
    }
    state.registrationFacts = facts;
  }

  ctx.llm.registerModelDiscovery(NS, (request) => {
    const source = request.provider === undefined ? undefined : (sourcesKey(request.provider) ?? request.provider);
    if (source === undefined) return [];
    const route = state.profiles.get(request.provider);
    const catalog = state.catalog?.[source];
    const mapped = mapModels(request.provider, source, catalog, route === undefined ? {} : {});
    return mapped.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens }));
  });

  let sources = {};
  function sourcesKey(routeKey) {
    return sources?.[routeKey]?.source ?? (state.catalog?.[routeKey] !== undefined ? routeKey : undefined);
  }

  return {
    update(nextSources, catalog) {
      sources = nextSources ?? {};
      state.catalog = catalog ?? {};
      state.profiles = buildProfiles(sources, state.catalog);
      ensureDirectory();
      ensureRegistration();
    },
    dispose() {
      try {
        state.registration?.dispose?.();
      } catch {
        // registration may not expose dispose across versions; nothing to do
      }
    },
  };
}
