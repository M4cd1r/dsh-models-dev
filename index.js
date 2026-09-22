// dsh-models-dev — live models.dev catalog for DeepSeek Harness LLM providers.
//
// Why: dsh-llm-pi-ai resolves routes against pi-ai's vendored model catalog, a
// build-time snapshot of models.dev that goes stale between releases (e.g.
// mimo-v2.6-* reachable on OpenCode Go while every installed catalog lacked
// them). This plugin fetches https://models.dev/api.json at startup and on a
// TTL, maps each configured provider's models onto pi-ai model entries, and
// registers the routes through the same ctx.llm seam llm-pi-ai uses — so
// providers and models come from the living catalog instead of the snapshot.
//
// Modes: give a route a key llm-pi-ai does not serve (e.g. `opencode-go-live`)
// to coexist, or remove the route from llm-pi-ai.providers and reuse its key
// here (e.g. `opencode-go`) to replace it.
//
// Host classes (PiAiAdapter, createProvider, LlmError) are resolved from the
// running dsh's own module instances via lib/runtime.mjs.

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from './lib/registry.mjs';
import { ModelsDevSync } from './lib/sync.mjs';
import { loadHostModules } from './lib/runtime.mjs';

/** Cordis plugin name (the Loader entry). */
export const name = 'dsh-models-dev';

/** Services required before load: the LLM seam we register into. */
export const inject = ['llm'];

const NS = 'dsh-models-dev';
const DEFAULT_URL = 'https://models.dev/api.json';
const MIN_REFRESH_HOURS = 0.05;

const modelProfile = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  input: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
});

const providerProfile = z.object({
  source: z.string().optional(),
  displayName: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
  api: z.string().optional(),
  defaultContextWindow: z.number().optional(),
  defaultMaxTokens: z.number().optional(),
  models: z.array(modelProfile).optional(),
});

/** Plugin configuration: the models.dev-backed provider routes this instance owns. */
export const Config = z.object({
  modelsDevUrl: z.string().default(DEFAULT_URL),
  refreshHours: z.number().min(MIN_REFRESH_HOURS).default(24),
  cachePath: z.string().optional(),
  providers: z.dict(providerProfile).default({}),
});

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function apply(ctx, config) {
  let current = () => config;

  const rebuild = async (registry, sync, { force = false } = {}) => {
    const cfg = current();
    const { data, stale } = await sync.load({ force });
    if (stale) ctx.logger?.warn?.(`${NS}: models.dev unreachable — serving the cached catalog`);
    registry.update(cfg.providers ?? {}, data);
  };

  void (async () => {
    try {
      const mods = await loadHostModules();
      const registry = createRegistry(ctx, mods);
      const cfg = current();
      const sync = new ModelsDevSync({
        url: cfg.modelsDevUrl ?? DEFAULT_URL,
        cachePath: cfg.cachePath ?? join(dshHome(), 'plugins', NS, 'models.dev.json'),
        ttlMs: Math.max(MIN_REFRESH_HOURS, cfg.refreshHours ?? 24) * 60 * 60 * 1000,
        logger: ctx.logger,
      });

      await rebuild(registry, sync);

      const timer = setInterval(() => {
        void rebuild(registry, sync, { force: true }).catch((error) => ctx.logger?.error?.(`${NS}: catalog refresh failed`, error));
      }, Math.max(MIN_REFRESH_HOURS, current().refreshHours ?? 24) * 60 * 60 * 1000);
      timer.unref?.();

      ctx.on?.('dispose', () => {
        clearInterval(timer);
        registry.dispose();
      });

      ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, NS, Config, config, {
          validate: () => {},
          setSource: (source) => {
            current = source;
          },
          onChange: () => {
            void rebuild(registry, sync).catch((error) => ctx.logger?.error?.(`${NS}: keeping the previously registered routes after a refused update`, error));
          },
        });
      });
    } catch (error) {
      ctx.logger?.error?.(`${NS}: bootstrap failed — no models.dev routes registered`);
      ctx.logger?.error?.(error);
    }
  })();
}
