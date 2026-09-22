// scripts/bootstrap.mjs — prove the plugin bootstraps inside the running dsh.
//
// Mirrors the host composition faithfully, because the two details that broke it
// in production are exactly the ones a naive stub hides:
//   * the loader entry carries NO config — providers live in settings.yaml and
//     arrive through the settings section's setSource hook;
//   * the llm seam refuses an empty configurable-provider registration by design.
// The stub llm therefore rejects an empty registration like the real one does,
// and the stub settings service delivers a resolved value on install.
//
// Usage: node scripts/bootstrap.mjs [path/to/index.js]
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const NS = 'dsh-models-dev';
const ROUTE = 'opencode-go-live';
const pluginIndex = process.argv[2] ?? fileURLToPath(new URL('../index.js', import.meta.url));

const CATALOG = {
  'opencode-go': {
    id: 'opencode-go',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/go/v1',
    name: 'OpenCode Go',
    models: {
      'mimo-v2.6-pro': {
        id: 'mimo-v2.6-pro',
        name: 'MiMo-V2.6-Pro',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1048576, output: 131072 },
        cost: { input: 0.435, output: 0.87, cache_read: 0.003625 },
      },
    },
  },
};

// Always a fresh state dir: the plugin's trace is append-only, so reusing an
// existing $DSH_HOME would let a previous run's markers decide this run's verdict.
const home = mkdtempSync(join(tmpdir(), 'dsh-models-dev-bootstrap-'));
process.env.DSH_HOME = home;
const cachePath = join(home, 'bootstrap-catalog.json');
writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: CATALOG }));

const RESOLVED = {
  modelsDevUrl: 'https://models.dev/api.json',
  refreshHours: 24,
  cachePath,
  providers: {
    [ROUTE]: { source: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY', displayName: 'OpenCode Go (models.dev live)' },
  },
};

const sections = [];
const adapters = [];
const directories = [];
const errors = [];

const llm = {
  registerConfigurableProviders: (entries) => {
    if (entries.length === 0) throw new Error('LlmError: a configurable-provider registration must declare at least one provider');
    directories.push(...entries.map((entry) => entry.provider));
    return Object.assign(() => {}, { replace: () => {} });
  },
  registerAdapter: (routes) => {
    if (routes.length === 0) throw new Error('LlmError: an adapter must register at least one provider');
    adapters.push(...routes);
    return Object.assign(() => {}, { replace: () => {} });
  },
  registerModelDiscovery: () => {},
};

const settings = {
  installSection: (_owner, ns, _schema, _entry, hooks) => {
    if (sections.includes(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    sections.push(ns);
    hooks.setSource(() => RESOLVED);
    hooks.onChange();
  },
};

const ctx = {
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) => errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
  },
  llm,
  get: (name) => (name === 'settings' ? settings : undefined),
  on: () => {},
  effect: () => {},
  inject: (_deps, callback) => callback({ settings }),
};

const { apply } = await import(pathToFileURL(pluginIndex).href);
apply(ctx, {}); // the bundle entry carries no config, exactly like the deployment

const tracePath = join(home, 'plugins', NS, 'bootstrap.log');
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  if (existsSync(tracePath) && /bootstrap: (done|FAILED)/.test(readFileSync(tracePath, 'utf8'))) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';

const problems = [];
if (!sections.includes(NS)) problems.push(`no settings section for "${NS}"`);
if (!adapters.includes(ROUTE)) problems.push(`no adapter route "${ROUTE}" (registered: ${adapters.join(', ') || 'none'})`);
if (!directories.includes(ROUTE)) problems.push(`no directory entry "${ROUTE}" (declared: ${directories.join(', ') || 'none'})`);
if (!existsSync(cachePath) || statSync(cachePath).size === 0) problems.push(`no catalog cache at ${cachePath}`);
if (/bootstrap: FAILED/.test(trace)) {
  problems.push(`trace reports a failure:\n${trace.split('\n').filter((line) => line.includes('FAILED')).join('\n')}`);
}
if (errors.length > 0) problems.push(`logger errors: ${errors.join(' | ')}`);

if (problems.length > 0) {
  console.error(`bootstrap: FAIL — ${problems.join('; ')}`);
  process.exit(1);
}

console.log(`bootstrap: OK — section "${NS}", route "${ROUTE}", directory "${directories.join(',')}", cache ${cachePath}`);
