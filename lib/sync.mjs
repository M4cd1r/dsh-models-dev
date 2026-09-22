// sync.mjs — fetch the models.dev catalog with a TTL cache and offline fallback.
//
// https://models.dev/api.json is one JSON object keyed by provider id. We cache
// it under $DSH_HOME/plugins/dsh-models-dev/ so a cold start with no network
// still serves the last known catalog (marked stale) instead of losing routes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ModelsDevSync {
  constructor({ url = DEFAULT_URL, cachePath, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
    this.url = url;
    this.cachePath = cachePath;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.memory = undefined;
  }

  readCache() {
    if (this.cachePath === undefined) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      if (parsed && typeof parsed.data === 'object' && parsed.data !== null) return parsed;
    } catch {
      // missing or corrupt cache — fall through
    }
    return undefined;
  }

  writeCache(entry) {
    if (this.cachePath === undefined) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, this.cachePath);
    } catch (error) {
      this.logger?.warn?.(`dsh-models-dev: could not write the catalog cache: ${error?.message ?? error}`);
    }
  }

  /**
   * Load the catalog: memory → fresh disk cache → network → stale disk cache.
   * @param {{force?: boolean}} options - `force` skips the freshness checks and refetches.
   * @returns {Promise<{data: object, fetchedAt: string, stale: boolean}>}
   */
  async load({ force = false } = {}) {
    const now = Date.now();
    const fresh = (entry) => !force && now - Date.parse(entry.fetchedAt) < this.ttlMs;
    if (this.memory && fresh(this.memory)) return { ...this.memory, stale: false };

    const cached = this.readCache();
    if (cached && fresh(cached)) {
      this.memory = cached;
      return { ...cached, stale: false };
    }

    try {
      const response = await fetch(this.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
      const data = await response.json();
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('models.dev answered an unexpected shape');
      const entry = { fetchedAt: new Date(now).toISOString(), data };
      this.memory = entry;
      this.writeCache(entry);
      return { ...entry, stale: false };
    } catch (error) {
      if (cached !== undefined) {
        this.logger?.warn?.(`dsh-models-dev: models.dev unreachable (${error?.message ?? error}) — serving the cached catalog from ${cached.fetchedAt}`);
        return { ...cached, stale: true };
      }
      throw new Error(`dsh-models-dev: could not fetch ${this.url} and no cached catalog exists: ${error?.message ?? error}`);
    }
  }
}
