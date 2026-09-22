// scripts/bootstrap.mjs — prove the plugin bootstraps inside the running dsh.
//
// The settings section and the model routes are registered by an async
// bootstrap inside apply(): host modules → registry → catalog fetch → then
// ctx.inject(['settings']). A failure anywhere in that chain is swallowed by
// the plugin's own catch, so the fiber still reports "Running" while nothing
// was registered. This script replays that chain against the real dsh host
// modules with a stub ctx, and fails when the section, the routes, or the
// catalog cache is missing.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.DSH_MODELS_DEV_DSH_BIN,
  'C:/Users/admin/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh/lib/bin.js',
];
const anchor = CANDIDATES.find((candidate) => typeof candidate === 'string' && existsSync(candidate));
if (anchor === undefined) {
  console.log('bootstrap: skipped (no dsh checkout on this machine)');
  process.exit(0);
}
process.argv[1] = anchor;

const pluginIndex = process.argv[2] ?? fileURLToPath(new URL('../index.js', import.meta.url));
const NS = 'dsh-models-dev';
const ROUTE = 'opencode-go-live';

const sections = [];
const adapters = [];
const directories = [];
const errors = [];

const ctx = {
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) => errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
  },
  llm: {
    registerConfigurableProviders: (entries) => {
      directories.push(...entries.map((entry) => entry.provider));
      return { replace: () => {} };
    },
    registerAdapter: (routes) => {
      adapters.push(...routes);
      return { replace: () => {}, dispose: () => {} };
    },
    registerModelDiscovery: () => {},
  },
  get: () => undefined,
  on: () => {},
  effect: () => {},
  inject: (_deps, callback) => callback({ settings: { installSection: (_owner, ns) => sections.push(ns) } }),
};

const { apply } = await import(pathToFileURL(pluginIndex).href);
apply(ctx, { providers: { [ROUTE]: { source: 'opencode-go' } } });

const cachePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', NS, 'models.dev.json');
const deadline = Date.now() + 20000;
while (Date.now() < deadline && (sections.length === 0 || adapters.length === 0)) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const problems = [];
if (!sections.includes(NS)) problems.push(`no settings section for "${NS}"`);
if (!adapters.includes(ROUTE)) problems.push(`no adapter route "${ROUTE}" (registered: ${adapters.join(', ') || 'none'})`);
if (!existsSync(cachePath)) problems.push(`no catalog cache at ${cachePath}`);
else if (statSync(cachePath).size === 0) problems.push(`empty catalog cache at ${cachePath}`);

if (errors.length > 0) problems.push(`logger errors: ${errors.join(' | ')}`);

if (problems.length > 0) {
  console.error(`bootstrap: FAIL — ${problems.join('; ')}`);
  process.exit(1);
}

console.log(`bootstrap: OK — section "${NS}", route "${ROUTE}", cache ${cachePath}`);
