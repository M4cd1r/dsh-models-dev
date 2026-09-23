// dsh-models-dev — keep every hooked-up provider's model catalog current with
// the living models.dev catalog.
//
// Why: providers configured in dsh carry model rows whose modalities and
// thinking levels drift stale (and new models never appear) between releases.
// This plugin does not register routes of its own — no duplicated providers.
// Instead it refreshes the `models` array of the providers already configured
// (llm-pi-ai family: the rows the Models page's capability editor edits) from
// https://models.dev/api.json: new models appended, existing models updated in
// place, hand-added models left alone.
//
// Surfaces: an automatic sweep at bootstrap and on a timer (`autoSync`,
// `refreshHours`), and one loopback endpoint the "update models from models.dev
// API" button in the capability editor drives per provider.
//
// A bootstrap trace in $DSH_HOME/plugins/dsh-models-dev/bootstrap.log keeps the
// async chain auditable — a deployment without a logger exporter would
// otherwise swallow every failure behind a "Running" fiber.

import z from '@deepseek-ai/schemastery';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { syncRoutes, TARGET_NS } from './lib/service.mjs';
import { ModelsDevSync } from './lib/sync.mjs';

/** Cordis plugin name (the Loader entry). */
export const name = 'dsh-models-dev';

/** Services required before load: the llm directory tells us what is hooked up. */
export const inject = ['llm'];

const NS = 'dsh-models-dev';
const DEFAULT_URL = 'https://models.dev/api.json';
const MIN_REFRESH_HOURS = 0.05;
const REFRESH_PATH = '/api/dsh-models-dev/refresh';
const MAX_BODY_BYTES = 64 * 1024;

/** Plugin configuration: where the living catalog lives and when to sweep. */
export const Config = z.object({
  modelsDevUrl: z.string().default(DEFAULT_URL),
  refreshHours: z.number().min(MIN_REFRESH_HOURS).default(24),
  cachePath: z.string().required(false),
  autoSync: z.boolean().default(true),
  sources: z.dict(z.string()).default({}),
});

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * Append-only bootstrap trace under this plugin's state dir.
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

/** Answer one JSON response. */
function writeJson(res, status, value) {
  try {
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.writeHead(status);
    res.end(JSON.stringify(value));
  } catch {
    // the socket went away mid-answer; nothing to recover
  }
}

/**
 * Read one small JSON request body (empty bodies read as {}).
 *
 * Deliberately event-based instead of `for await (const chunk of req)`: the
 * async iterator a Node stream hands out checks `this === stream` inside its own
 * 'readable' listener, and the LAN replay layer (dsh-lan-replay) passes handlers
 * a Proxy over the request. The 'readable' event is emitted by the raw
 * IncomingMessage, so the listener runs with `this` = the raw stream, the
 * comparison fails, and the iterator stores the (undefined) event argument where
 * it keeps its pending promise. Two consequences, both observed live:
 *
 *   - the body read never settles — the refresh endpoint hung forever for every
 *     trusted-LAN request, so the button did nothing;
 *   - the first request-stream error after that (a browser abort — e.g. the page
 *     reloading while the request is pending) runs the iterator's end-of-stream
 *     callback, which calls the clobbered `callback()` and throws
 *     "TypeError: callback is not a function" from inside an event handler: an
 *     uncaught exception that kills the whole dsh host (exit 1, watchdog
 *     restart, LAN down until it comes back).
 *
 * Explicit listeners carry no identity requirement and behave identically
 * through a Proxy — same body, same errors, no host crash.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', finish);
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}

/** The shared fence: loopback only (a trusted LAN request is replayed as one). */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function apply(ctx, config) {
  let current = () => config;
  trace(`apply: called (loader autoSync=${config?.autoSync}, sources=${Object.keys(config?.sources ?? {}).join(',') || 'none'})`);

  /** The pieces the sweep and the endpoint need; filled by the bootstrap. */
  const state = { sync: undefined, settings: undefined };

  /**
   * One sweep: one catalog read, then every hooked-up pi-ai route (or only the
   * named ones). A route the catalog does not describe is reported and skipped.
   * `log` collects this attempt's trace lines — the endpoint hands them to the
   * client so an error notification can show what the host actually did.
   */
  const runSync = async ({ force = false, routes, log } = {}) => {
    const { sync, settings } = state;
    if (sync === undefined || settings === undefined) return [];
    const cfg = current();
    const note = (line) => {
      trace(line);
      if (Array.isArray(log)) log.push(line);
    };
    note(`refresh: loading catalog (force=${force}${routes === undefined ? '' : `, routes=${routes.join(',')}`})`);
    const { data, stale } = await sync.load({ force });
    note(`refresh: catalog ${Object.keys(data ?? {}).length} providers (stale=${stale})`);
    if (stale) ctx.logger?.warn?.(`${NS}: models.dev unreachable — serving the cached catalog`);
    const wanted = routes === undefined ? undefined : new Set(routes);
    const providers = (ctx.llm.listConfigurableProviders?.() ?? []).filter(
      (row) => row?.settingsNs === TARGET_NS && (wanted === undefined || wanted.has(row.provider)),
    );
    const results = await syncRoutes({ settings, providers, catalog: data, sources: cfg.sources ?? {} });
    note(`refresh: ${JSON.stringify(results)}`);
    return results;
  };

  /** A settings change swaps the live source first; the models follow. */
  const onSettingsChange = () => {
    void runSync().catch((error) => ctx.logger?.error?.(`${NS}: keeping the previously refreshed models after a refused update`, error));
  };

  /** The settings section owns the live config values (see the sync's source swap). */
  const installSettings = (settings) => {
    try {
      settings.installSection(ctx, NS, Config, config, {
        validate: () => {},
        setSource: (source) => {
          current = source;
        },
        onChange: onSettingsChange,
      });
      state.settings = settings;
      trace('bootstrap: settings section installed');
    } catch (error) {
      trace(`bootstrap: installSection FAILED — ${error?.stack ?? error}`);
      throw error;
    }
  };

  /** POST {route?}: the refresh button's endpoint; no body sweeps everything. */
  const handleRefresh = (req, res) => {
    if (!isLoopback(req)) return void writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
    if (req.method !== 'POST') return void writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
    const log = [];
    return readJsonBody(req)
      .then((body) => {
        const route = typeof body?.route === 'string' && body.route.length > 0 ? [body.route] : undefined;
        return runSync({ force: true, routes: route, log });
      })
      .then(
        (results) => writeJson(res, 200, { ok: true, results, log }),
        // A failure answers with the message, its stack and the attempt log —
        // exactly what the client's error notification renders.
        (error) =>
          writeJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
            log,
          }),
      );
  };

  void (async () => {
    try {
      trace('bootstrap: start');
      // Service access is strict in cordis: a plain property read of a service the
      // fiber did not declare in `inject` throws "cannot get property ... without
      // inject", so the optional seats are read with the lenient get(name, false).
      const settings = ctx.get('settings', false);
      if (settings !== undefined) installSettings(settings);
      else trace('bootstrap: settings service not up yet — installing when it appears');

      const cfg = current();
      const sync = new ModelsDevSync({
        url: cfg.modelsDevUrl ?? DEFAULT_URL,
        cachePath: cfg.cachePath ?? join(dshHome(), 'plugins', NS, 'models.dev.json'),
        ttlMs: Math.max(MIN_REFRESH_HOURS, cfg.refreshHours ?? 24) * 60 * 60 * 1000,
        logger: ctx.logger,
      });
      state.sync = sync;
      trace('bootstrap: catalog sync ready');

      // The refresh endpoint: what the "update models from models.dev API" button
      // drives. The webserver seat can appear after this plugin (like settings),
      // so it is claimed through inject when it is not up yet.
      const webServer = ctx.get('webServer', false);
      const seatEndpoint = (seat) => {
        if (seat === undefined || typeof seat.register !== 'function') return;
        seat.register({ kind: 'exact', path: REFRESH_PATH, handler: handleRefresh });
        trace(`bootstrap: refresh endpoint on ${REFRESH_PATH}`);
      };
      if (webServer !== undefined) seatEndpoint(webServer);
      else {
        trace('bootstrap: webserver seat not up yet — claiming it when it appears');
        ctx.inject(['webServer'], (webCtx) => seatEndpoint(webCtx.webServer));
      }

      // The automatic check for everything hooked up: once here (the catalog
      // cache decides whether models.dev needs a fetch), then every refresh.
      if (cfg.autoSync !== false) await runSync();

      const timer = setInterval(() => {
        void runSync({ force: true }).catch((error) => ctx.logger?.error?.(`${NS}: catalog refresh failed`, error));
      }, Math.max(MIN_REFRESH_HOURS, current().refreshHours ?? 24) * 60 * 60 * 1000);
      timer.unref?.();
      ctx.on?.('dispose', () => clearInterval(timer));

      if (settings === undefined) {
        ctx.inject(['settings'], (settingsCtx) => {
          installSettings(settingsCtx.settings);
          onSettingsChange();
        });
      }
      trace('bootstrap: done');
    } catch (error) {
      trace(`bootstrap: FAILED — ${error?.stack ?? error}`);
      ctx.logger?.error?.(`${NS}: bootstrap failed — models were not refreshed`);
      ctx.logger?.error?.(error);
    }
  })();
}
