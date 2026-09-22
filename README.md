# dsh-models-dev

**Live [models.dev](https://models.dev) catalog for DeepSeek Harness LLM providers.** ([README.zh.md](README.zh.md))

`dsh-llm-pi-ai` resolves providers and models against pi-ai's **vendored** catalog — a build-time snapshot of models.dev that goes stale between releases. When OpenCode Go added `mimo-v2.6-pro` (2026-09-22), every installed pi-ai catalog still lacked it and dsh refused the route: *"provider "opencode-go" model "mimo-v2.6-pro" needs an api; the installed catalog does not describe it"*.

This plugin replaces that snapshot mechanism for the routes it owns: it fetches `https://models.dev/api.json` at startup and on a TTL, maps each configured provider's models onto pi-ai model entries (wire protocol, endpoint, costs, limits, modalities), and registers the routes through the same `ctx.llm` seam `llm-pi-ai` uses. New models on models.dev show up without waiting for a pi-ai release.

## Install

```
dsh plugin --profile web add dsh-models-dev
```

Restart dsh afterwards (the plugin mounts through the profile bundle patch).

## Configure

Settings section `dsh-models-dev` (e.g. in `~/.dsh/settings.yaml`):

```yaml
dsh-models-dev:
  refreshHours: 24          # catalog refresh interval (optional)
  providers:
    opencode-go:            # dsh route key — THIS key decides coexistence vs replacement
      source: opencode-go   # models.dev provider id (defaults to the route key)
      apiKeyEnv: OPENCODE_GO_API_KEY
```

That is enough: every tool-capable, non-deprecated model models.dev lists for `opencode-go` becomes a selectable dsh model.

**Replace mode** — reuse the key llm-pi-ai serves (`opencode-go`) and *remove* that route from `llm-pi-ai.providers` first; a route key can only be registered by one adapter.

**Coexist mode** — pick a key llm-pi-ai does not serve:

```yaml
dsh-models-dev:
  providers:
    opencode-go-live:
      source: opencode-go
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:                       # optional: serve a subset / override fields
        - id: mimo-v2.6-pro
          name: MiMo V2.6 Pro
          maxTokens: 131072         # explicit maxTokens also becomes the per-request default
```

Per-route fields: `source`, `displayName`, `apiKeyEnv`, `baseURL`, `api` (force one wire protocol for every model), `defaultContextWindow`, `defaultMaxTokens`, `models` (id + optional `name`/`contextWindow`/`maxTokens`/`input`/`reasoning`/`thinkingLevelMap` overrides; when present, only listed ids are served). A model's `thinkingLevelMap` entry replaces the levels models.dev declares for it, and `false` strips them so a gateway the catalog over-claims for falls back to pi-ai's provider defaults.

## How it works

1. **Fetch** — `models.dev/api.json` on startup and every `refreshHours`, cached under `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`; on network failure the last cached catalog keeps serving (logged as stale).
2. **Map** — pure mapping (`lib/map.mjs`) mirroring pi-ai's `generate-models.ts` rules: `provider.npm` (per-model override wins) picks the wire protocol (`@ai-sdk/anthropic` → `anthropic-messages`, `@ai-sdk/openai` → `openai-responses`, else `openai-completions`); `provider.api` is the base URL (Anthropic routes get the SDK-appended `/v1/messages` shape); costs/limits/modalities map 1:1; a model's `reasoning_options` effort values become its `thinkingLevelMap`, so the selectable thinking levels come from models.dev (`none` is the wire spelling for `off`, omitted levels are pinned unsupported); `reasoning_content` interleaving marks replay compatibility. Compat switches pi-ai can detect from provider id + baseURL stay unset, so its own detection decides.
3. **Register** — one `PiAiAdapter` (reused from `@deepseek-ai/dsh-llm-pi-ai`) serves all routes, registered via `ctx.llm.registerAdapter`, with `registerConfigurableProviders` (settings UI) and `registerModelDiscovery` (models.dev-backed "fetch models"). Host classes are resolved from the running dsh's own module instances, so the seam sees matching class identity.

## Limitations

- Only the `effort` entries of `reasoning_options` are mapped. `budget_tokens` (`min`/`max`) and `toggle` entries are ignored: pi-ai's thinking levels take a wire value or `null`, which has no budget-range counterpart. A model that declares no effort values (e.g. `mimo-v2.6-pro`) keeps `reasoning: true` with no `thinkingLevelMap`, leaving pi-ai's provider defaults in charge — configure `thinkingLevelMap` per model to override.
- `google-generative-ai` models are reported as unusable (listed, not dispatchable).
- Models without `tool_call: true` and `status: deprecated` models are skipped (a coding agent cannot use them).

## Development

```
npm run verify   # syntax check + unit tests + smoke (live models.dev check is best-effort)
```

## License

MIT
