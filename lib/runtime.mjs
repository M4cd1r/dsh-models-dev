// runtime.mjs — resolve the RUNNING dsh's own module instances.
//
// The plugin executes inside the dsh process, but its own node_modules may
// contain different copies of @earendil-works/pi-ai and @deepseek-ai/* than
// the ones the harness loaded. Class identity matters across the adapter seam
// (LlmAdapter, Provider, Model), so we resolve every host package through the
// dsh entry point (`process.argv[1]`, the running `dsh/lib/bin.js`) with
// createRequire and import the resolved paths: Node's ESM cache is keyed by
// resolved URL, which returns the exact instances dsh-llm-pi-ai uses.

import { createRequire } from 'node:module';

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

/** Candidate filenames to resolve host packages from, most authoritative first. */
function anchors() {
  const out = [];
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) out.push(process.argv[1]);
  return out;
}

/**
 * Load every host module the registry needs from the running dsh.
 * @returns the resolved module namespaces, including the three pi-ai API factories.
 * @throws Error when no anchor resolves the host packages (not running inside dsh).
 */
export async function loadHostModules() {
  const failures = [];
  for (const anchor of anchors()) {
    try {
      const require_ = createRequire(anchor);
      const entries = await Promise.all(
        Object.entries({ ...HOST_PACKAGES, ...API_MODULES }).map(async ([key, spec]) => [key, await import(require_.resolve(spec))]),
      );
      return Object.fromEntries(entries);
    } catch (error) {
      failures.push(`${anchor}: ${error?.message ?? error}`);
    }
  }
  throw new Error(
    `dsh-models-dev: cannot resolve the running dsh host modules (@deepseek-ai/dsh-llm-pi-ai, @earendil-works/pi-ai, …). ` +
      `This plugin must load inside a dsh process. Tried: ${failures.join(' | ')}`,
  );
}
