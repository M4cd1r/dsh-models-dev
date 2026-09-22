// map.mjs — models.dev provider data → pi-ai Model entries (pure, no I/O).
//
// Mapping rules mirror pi-ai's scripts/generate-models.ts (MIT, earendil-works/pi):
// the AI SDK package (`provider.npm`, overridable per model) picks the wire
// protocol, `provider.api` is the OpenAI-style base URL, costs/limits/modalities
// map 1:1, tool-call-less and deprecated models are skipped. Everything pi-ai
// can detect at runtime from provider id + baseURL (compat switches) is left
// unset so its own detection decides — the same contract the generated catalog
// relies on.

const PROTOCOL_BY_NPM = {
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/alibaba': 'openai-completions',
  '@ai-sdk/openai-compatible': 'openai-completions',
};

const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

function cleanBase(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

/** The Anthropic SDK appends /v1/messages to its baseURL; models.dev publishes the OpenAI-style …/v1 base. */
function anthropicBase(openaiStyle) {
  return cleanBase(String(openaiStyle ?? '').replace(/\/v1\/?$/, ''));
}

/**
 * Map one models.dev provider's models onto pi-ai model entries.
 * @param routeKey - dsh route key stamped as `provider` on every model.
 * @param providerId - models.dev provider id (for diagnostics).
 * @param providerData - the models.dev provider object ({ id, env, npm, api, name, models }).
 * @param route - the configured route profile (overrides, filters, forced api/baseURL).
 * @returns {{ models: object[], configuredMaxTokens: Map<string, number>, errors: Map<string, string> }}
 */
export function mapModels(routeKey, providerId, providerData, route = {}) {
  const models = [];
  const errors = new Map();
  const configuredMaxTokens = new Map();
  if (providerData === undefined || providerData === null || typeof providerData !== 'object') {
    errors.set(routeKey, `models.dev has no provider "${providerId}" — check the route's "source"`);
    return { models, configuredMaxTokens, errors };
  }
  const declared = Array.isArray(route.models) ? route.models : undefined;
  const wanted = declared ? new Map(declared.map((entry) => [entry.id, entry])) : undefined;
  const npmDefault = providerData.npm ?? '@ai-sdk/openai-compatible';
  const apiDefault = providerData.api ?? '';

  for (const [id, raw] of Object.entries(providerData.models ?? {})) {
    const over = wanted?.get(id);
    if (wanted && over === undefined) continue;
    if (raw?.tool_call !== true) {
      if (wanted) errors.set(id, `models.dev does not list "${id}" as tool-capable; a coding agent cannot use it`);
      continue;
    }
    if (raw.status === 'deprecated') {
      if (wanted) errors.set(id, `models.dev lists "${id}" as deprecated`);
      continue;
    }

    const npm = raw.provider?.npm ?? npmDefault;
    const api = route.api ?? PROTOCOL_BY_NPM[npm] ?? 'openai-completions';
    if (api === 'google-generative-ai') {
      errors.set(id, `"${id}" speaks google-generative-ai, which this build cannot dispatch; it is listed but unusable`);
      continue;
    }
    const rawBase = raw.provider?.api ?? apiDefault;
    const baseUrl = route.baseURL ?? (api === 'anthropic-messages' ? anthropicBase(rawBase) : cleanBase(rawBase));
    if (baseUrl.length === 0) {
      errors.set(id, `models.dev publishes no endpoint for "${id}" and the route sets no baseURL`);
      continue;
    }

    const input = (raw.modalities?.input ?? ['text']).includes('image') ? ['text', 'image'] : ['text'];
    const compat = {};
    if (raw.interleaved?.field === 'reasoning_content') compat.requiresReasoningContentOnAssistantMessages = true;

    const model = {
      id,
      name: over?.name ?? raw.name ?? id,
      api,
      provider: routeKey,
      baseUrl,
      reasoning: over?.reasoning ?? raw.reasoning === true,
      input: over?.input ?? input,
      cost: {
        input: raw.cost?.input ?? 0,
        output: raw.cost?.output ?? 0,
        cacheRead: raw.cost?.cache_read ?? 0,
        cacheWrite: raw.cost?.cache_write ?? 0,
      },
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      contextWindow: over?.contextWindow ?? raw.limit?.context ?? route.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: over?.maxTokens ?? raw.limit?.output ?? route.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (over?.maxTokens !== undefined) configuredMaxTokens.set(id, over.maxTokens);
    models.push(model);
  }

  if (wanted) {
    for (const id of wanted.keys()) {
      if (!models.some((model) => model.id === id) && !errors.has(id)) {
        errors.set(id, `models.dev provider "${providerId}" does not list "${id}"`);
      }
    }
  }
  return { models, configuredMaxTokens, errors };
}
