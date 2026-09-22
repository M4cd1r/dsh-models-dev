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
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  name: z.string().required(false),
  contextWindow: z.number().required(false),
  maxTokens: z.number().required(false),
  input: z.array(z.string()).required(false),
  reasoning: z.boolean().required(false),
});

const providerProfile = z.object({
  source: z.string().required(false),
  displayName: z.string().required(false),
  apiKeyEnv: z.string().required(false),
  baseURL: z.string().required(false),
  api: z.string().required(false),
  defaultContextWindow: z.number().required(false),
  defaultMaxTokens: z.number().required(false),
  models: z.array(modelProfile).required(false),
});

/** Plugin configuration: the models.dev-backed provider routes this instance owns. */
export const Config = z.object({
  modelsDevUrl: z.string().default(DEFAULT_URL),
  refreshHours: z.number().min(MIN_REFRESH_HOURS).default(24),
  cachePath: z.string().required(false),
  providers: z.dict(providerProfile).default({}),
});

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * Append-only bootstrap trace under this plugin's state dir.
 *
 * The bootstrap is an async chain (host modules → registry → catalog → settings
 * section) whose failures land in `ctx.logger`; a deployment that wires no
 * logger exporter buffers them where nobody reads them, leaving a "Running"
 * fiber that registered nothing. The trace separates "the entry imported the
 * module" from "apply() was called" from each bootstrap step, and never throws
 * into the plugin.
 *
 * @param line - one trace record; the writer adds a UTC stamp and the pid.
 */
function trace(line) {
  try {
    const path = join(dshHome(), 'plugins', NS, 'bootstrap.log');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`);
  } catch {
    // tracing is best-effort: it must never take the plugin down
  }
}

trace('module: imported');

export function apply(ctx, config) {
  let current = () => config;
  trace(`apply: called (loader routes=${Object.keys(config?.providers ?? {}).join(',') || 'none'})`);

  // Registry and catalog sync exist only once the bootstrap reaches them: the
  // settings section reports a change synchronously while installing, before
  // this holder is filled.
  const state = { registry: undefined, sync: undefined };

  const rebuild = async ({ force = false } = {}) => {
    const { registry, sync } = state;
    if (registry === undefined || sync === undefined) return;
    const cfg = current();
    const routes = Object.keys(cfg.providers ?? {});
    trace(`catalog: loading (force=${force}, routes=${routes.join(',') || 'none'})`);
    const { data, stale } = await sync.load({ force });
    trace(`catalog: ${Object.keys(data ?? {}).length} providers (stale=${stale})`);
    if (stale) ctx.logger?.warn?.(`${NS}: models.dev unreachable — serving the cached catalog`);
    registry.update(cfg.providers ?? {}, data);
    trace('catalog: routes registered');
  };

  const onSettingsChange = () => {
    void rebuild().catch((error) => ctx.logger?.error?.(`${NS}: keeping the previously registered routes after a refused update`, error));
  };

  const installSettings = (settings) => {
    try {
      settings.installSection(ctx, NS, Config, config, {
        validate: () => {},
        setSource: (source) => {
          current = source;
        },
        onChange: onSettingsChange,
      });
      trace('bootstrap: settings section installed');
    } catch (error) {
      trace(`bootstrap: installSection FAILED — ${error?.stack ?? error}`);
      throw error;
    }
  };

  void (async () => {
    try {
      trace('bootstrap: start');
      const mods = await loadHostModules();
      trace(`bootstrap: host modules resolved (${Object.keys(mods).join(',')})`);
      const registry = createRegistry(ctx, mods);
      trace('bootstrap: registry created');

      // The settings section owns the live values. installSection swaps `current`
      // for a getter over the resolved namespace (schema defaults ← this loader
      // entry ← the settings.yaml user layer) and pings onChange, so it has to be
      // installed BEFORE the first catalog load: the loader entry this plugin is
      // composed with carries no providers — they live in settings.yaml. Loading
      // the catalog first read an empty route set, and the seam's refusal of an
      // empty configurable-provider registration aborted the whole bootstrap.
      const settings = ctx.get?.('settings');
      if (settings !== undefined) installSettings(settings);
      else trace('bootstrap: settings service not up yet — installing when it appears');

      const cfg = current();
      const sync = new ModelsDevSync({
        url: cfg.modelsDevUrl ?? DEFAULT_URL,
        cachePath: cfg.cachePath ?? join(dshHome(), 'plugins', NS, 'models.dev.json'),
        ttlMs: Math.max(MIN_REFRESH_HOURS, cfg.refreshHours ?? 24) * 60 * 60 * 1000,
        logger: ctx.logger,
      });
      state.registry = registry;
      state.sync = sync;

      await rebuild();

      const timer = setInterval(() => {
        void rebuild({ force: true }).catch((error) => ctx.logger?.error?.(`${NS}: catalog refresh failed`, error));
      }, Math.max(MIN_REFRESH_HOURS, current().refreshHours ?? 24) * 60 * 60 * 1000);
      timer.unref?.();

      ctx.on?.('dispose', () => {
        clearInterval(timer);
        registry.dispose();
      });

      if (settings === undefined) {
        ctx.inject(['settings'], (settingsCtx) => {
          installSettings(settingsCtx.settings);
          onSettingsChange();
        });
      }
      trace('bootstrap: done');
    } catch (error) {
      trace(`bootstrap: FAILED — ${error?.stack ?? error}`);
      ctx.logger?.error?.(`${NS}: bootstrap failed — no models.dev routes registered`);
      ctx.logger?.error?.(error);
    }
  })();
}
