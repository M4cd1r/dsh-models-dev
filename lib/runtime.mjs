// runtime.mjs — resolve the RUNNING dsh's own module instances.
//
// The plugin executes inside the dsh process, but its own node_modules may
// contain different copies of @earendil-works/pi-ai and @deepseek-ai/* than
// the ones the harness loaded. Class identity matters across the adapter seam
// (LlmAdapter, Provider, Model), so we resolve every host package through the
// dsh entry point (`process.argv[1]`, the running `dsh/lib/bin.js`) with
// createRequire and import the resolved paths: Node's ESM cache is keyed by
// resolved URL, which returns the exact instances dsh-llm-pi-ai uses.
//
// createRequire().resolve() applies the `require` condition only, so a package
// whose exports map declares `import` alone — pi-ai does exactly that — fails
// there with ERR_PACKAGE_PATH_NOT_EXPORTED. resolveForImport() therefore falls
// back to the package's own exports map and returns the same file the ESM
// loader would pick, which keeps the module instance shared with the host.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_PACKAGES = {
  piAi: '@earendil-works/pi-ai',
  llmPiAi: '@deepseek-ai/dsh-llm-pi-ai',
  dshLlm: '@deepseek-ai/dsh-llm',
  credentials: '@deepseek-ai/dsh-credentials',
  launchEnvironment: '@deepseek-ai/dsh-launch-environment',
};

const API_MODULES = {
  anthropicApi: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
  completionsApi: '@earendil-works/pi-ai/api/openai-completions.lazy',
  responsesApi: '@earendil-works/pi-ai/api/openai-responses.lazy',
};

/** Conditions the ESM loader applies, in the order Node tries them. */
const IMPORT_CONDITIONS = ['import', 'node', 'default'];

/** Candidate filenames to resolve host packages from, most authoritative first. */
function anchors(override) {
  if (typeof override === 'string' && override.length > 0) return [override];
  return typeof process.argv[1] === 'string' && process.argv[1].length > 0 ? [process.argv[1]] : [];
}

/** Split a bare specifier into its package name and its `./sub` subpath. */
function splitSpecifier(spec) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = spec.slice(name.length);
  return { name, subpath: rest === '' ? '.' : `.${rest}` };
}

/** Resolve one exports target to a string, honoring nested condition objects. */
function pickCondition(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  for (const condition of IMPORT_CONDITIONS) {
    if (!Object.hasOwn(value, condition)) continue;
    const hit = pickCondition(value[condition]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Map one subpath through a package exports map: exact key first, then `*` patterns. */
function matchExports(exports_, subpath) {
  if (typeof exports_ === 'string') return subpath === '.' ? exports_ : undefined;
  if (exports_ === null || typeof exports_ !== 'object') return undefined;
  if (Object.hasOwn(exports_, subpath)) return pickCondition(exports_[subpath]);
  for (const [key, value] of Object.entries(exports_)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const target = pickCondition(value);
    if (target === undefined) continue;
    const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
    return target.replace('*', middle);
  }
  return undefined;
}

/** Find a package directory the anchor's require cannot resolve through exports. */
function locatePackage(require_, name) {
  for (const dir of require_.resolve.paths(name) ?? []) {
    const candidate = join(dir, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/**
 * Resolve one specifier to a file URL the ESM loader can import.
 *
 * require.resolve() is tried first, which keeps require-capable packages on the
 * exact path the host already uses. A package whose exports map declares only
 * `import` conditions (pi-ai 0.85.x) rejects that call, so the package's own
 * exports map decides instead — same file, same module instance.
 *
 * @param require_ - the require created from the running dsh entry point.
 * @param spec - bare package specifier, optionally with a subpath.
 * @returns the resolved file URL.
 * @throws Error when neither strategy locates an importable entry.
 */
export function resolveForImport(require_, spec) {
  try {
    return pathToFileURL(require_.resolve(spec));
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }

  const { name, subpath } = splitSpecifier(spec);
  const dir = locatePackage(require_, name);
  if (dir === undefined) throw new Error(`dsh-models-dev: cannot locate ${name} from the running dsh`);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const mapped = matchExports(manifest.exports, subpath) ?? (subpath === '.' ? (manifest.module ?? manifest.main) : undefined);
  if (mapped === undefined) throw new Error(`dsh-models-dev: ${name} does not export ${subpath} for import`);
  return pathToFileURL(join(dir, mapped));
}

/**
 * Load every host module the registry needs from the running dsh.
 * @param {{anchor?: string}} [options] - `anchor` overrides `process.argv[1]` (tests).
 * @returns the resolved module namespaces, including the three pi-ai API factories.
 * @throws Error when no anchor resolves the host packages (not running inside dsh).
 */
export async function loadHostModules({ anchor } = {}) {
  const failures = [];
  for (const candidate of anchors(anchor)) {
    try {
      const require_ = createRequire(candidate);
      const entries = await Promise.all(
        Object.entries({ ...HOST_PACKAGES, ...API_MODULES }).map(async ([key, spec]) => [
          key,
          await import(resolveForImport(require_, spec).href),
        ]),
      );
      return Object.fromEntries(entries);
    } catch (error) {
      failures.push(`${candidate}: ${error?.message ?? error}`);
    }
  }
  throw new Error(
    `dsh-models-dev: cannot resolve the running dsh host modules (@deepseek-ai/dsh-llm-pi-ai, @earendil-works/pi-ai, …). ` +
      `This plugin must load inside a dsh process. Tried: ${failures.join(' | ')}`,
  );
}
