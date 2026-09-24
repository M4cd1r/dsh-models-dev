# dsh-models-dev

Keep DSH provider model catalogs current with the **living** [models.dev](https://models.dev) catalog. ([README.zh.md](README.zh.md))

Configured providers in DeepSeek Harness carry model rows whose modalities (image
input) and thinking levels drift stale between releases, and new models never
appear. This plugin refreshes the `models` array of the providers you already use
— new models appended, existing models updated in place, hand-added models left
alone. It registers **no routes of its own**: no duplicated providers.

## Install

Requirements: Node.js >= 22.19 and `pnpm` on `PATH` (the CLI forwards package
operations to pnpm in the profile directory). Recommended install into the
Web profile:

```sh
dsh plugin --profile web add dsh-models-dev
```

`--profile web` is required — `dsh plugin add ...` is not the supported
complete form. The DSH Plugin Manager behind the command reads this package's
`dsh.bundle.patch: ./cordis.patch.yml`, adds `dsh-models-dev` to the profile's
`dsh.profile.bundles` (`~/.dsh/profiles/web/package.json`), and composes the
patch into the profile tree. There is nothing to copy and no `--patch` to
pass: a plain `pnpm add dsh-models-dev` only installs files — an unselected
dependency is not mounted, so installation alone does not prove bundle
selection.

Start Web with `dsh web` once the install has finished. If Web is already
running, the newly added bundle is applied through live reload when the
profile has HMR enabled; without HMR, restart. Replacing the version of an
already-loaded package always requires a process restart.

Optional install from source:

```sh
dsh plugin --profile web add github:M4cd1r/dsh-models-dev
```

The sidebar's **Plugins** page in Web is the UI alternative: it installs the
same npm package or GitHub spec into the currently managed profile.

The manifest's `dsh.engines.dsh` records the minimum DSH version as package
metadata; the compatibility gate of the current CLI checks declared peer
dependency ranges instead of this field.

## How it works

1. Fetch `https://models.dev/api.json` (24h TTL cache in
   `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`, offline fallback).
2. For every hooked-up route (the llm-pi-ai family rows of the configurable
   provider directory) map the models.dev records onto `models` entries:
   `modalities.input` → `input` (image checkbox), `reasoning_options` effort
   values → `reasoningEfforts` (thinking levels with their wire spellings).
3. Write the merged array back to `providers.<route>.models` with the settings
   seam's path ops and revision fencing — the same write the Models page's
   capability editor performs.

The route's `api`/`baseURL` (its wire endpoint) are handled far more
conservatively than the model rows, because they decide which endpoint — and
which bill — a call lands on. An absent field is left absent: llm-pi-ai's
installed catalog usually resolves it already, and pinning a models.dev endpoint
over that resolution is how a working route gets re-pointed at the wrong flavor
(models.dev's `zai` is the Z.AI **open platform**, while pi-ai's `zai` route is
the Z.AI **Coding Plan** — pinning the open-platform endpoint turns every call
into `429 Insufficient balance or no resource package`). The wire values are
written only when llm-pi-ai's strict validation refuses the write without them
(`needs an api` / `needs a baseURL`), and a pin left by 0.1.5–0.1.7 is repaired
once `sources` names the models.dev provider your route actually subscribes to.

> **Upgrading from 0.1.5–0.1.7:** if a route stopped working with a
> billing-shaped 429 after those releases, check its `baseURL` in *Settings →
> Models → (provider) Edit → Customized settings*. Those versions pinned the
> same-named models.dev endpoint; for a GLM Coding Plan key, add
> `sources: { zai: zai-coding-plan }` below (or set the Base URL to
> `https://api.z.ai/api/coding/paas/v4`) and the next refresh repairs it.

## Surfaces

- **Automatic check** — one sweep at startup and every `refreshHours` for
  everything hooked up (`autoSync`).
- **Refresh button** — in *Settings → Models → (provider) Edit → Model
  capabilities* header: a globe icon ("update models from models.dev API").
  Hovering spins it 360° (and eases back on leave); pressing it crossfades the
  globe into a loading spinner for the round trip. The answer pops a toast: a
  success card with the per-route counts (`opencode-go: +2/~28`), or an error
  card carrying the failure, the host log and the stack trace. Pressing it
  refreshes that provider's rows immediately.

```
POST /api/dsh-models-dev/refresh   body: { "route": "opencode-go" }   # or {} for all
```

The endpoint is loopback-fenced like the other in-box `/api` routes (a trusted
LAN request is replayed as loopback by dsh-lan).

## Settings

Requires DSH >= 0.1.7. The plugin's configuration is no longer a
`~/.dsh/settings.yaml` section: 0.1.7 renders the form from the plugin's own
config schema (*Settings → plugins → dsh-models-dev*) and keeps the values in
the active profile patch (`profiles/<name>/cordis.patch.yml`). Same keys as the
entry's `config:` block:

```yaml
dsh-models-dev:
  refreshHours: 24        # automatic sweep period (h)
  autoSync: true          # the automatic check at startup and on the timer
  modelsDevUrl: https://models.dev/api.json   # optional
  cachePath: ...          # optional catalog cache override
  sources:                # optional route -> models.dev provider id overrides
    my-gateway: opencode-go
    zai: zai-coding-plan  # GLM Coding Plan keys: models.dev's `zai` is the open platform
```

An edit applies live (the fields are volatile): the next sweep runs against the
new values without restarting the plugin.

Scope: the **llm-pi-ai family** rows (`settingsNs: llm-pi-ai`) — the model shape
this plugin writes (`input`, `reasoningEfforts`) is that family's schema. Other
adapters (e.g. the DeepSeek one) declare different shapes and are left alone.

A bootstrap trace is kept in `$DSH_HOME/plugins/dsh-models-dev/bootstrap.log`
(module import → apply → each step → failure stacks), because a deployment with
no logger exporter would otherwise hide every failure behind a "Running" fiber.

## Development

```
npm install
npm run verify      # syntax + unit tests + live smoke
npm run bootstrap   # replay the host composition against a stub ctx
```
