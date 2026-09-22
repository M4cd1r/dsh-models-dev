// test/bootstrap.test.mjs — the composition the host actually performs.
//
// Regression for the deployment failure: a bundle entry carries NO config (the
// providers live in settings.yaml and arrive through the settings section), and
// the llm seam refuses an empty configurable-provider registration by design.
// Loading the catalog before the settings section therefore threw
// ERR INVALID_DIRECTORY ("must declare at least one provider") and aborted the
// whole bootstrap — no routes, no settings section, and a fiber that still
// reported "Running".
//
// The harness builds a fake host package tree so the test needs no dsh
// checkout: those stubs mirror the shapes the plugin resolves by name, and
// pi-ai's exports carry an `import` condition only, like the real 0.85.x.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const NS = 'dsh-models-dev';
const ROUTE = 'opencode-go-live';

/** A minimal models.dev catalog entry that maps to one OpenAI-completions model. */
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

/** Write one fake package; `exports` mirrors the real maps (import-only where noted). */
function writePackage(root, name, manifest, files) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test', type: 'module', ...manifest }));
  for (const [file, body] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
}

/**
 * The host package tree the plugin resolves through process.argv[1].
 * pi-ai keeps its real shape: exports declare `import` alone, so require.resolve
 * cannot see it and only the exports-map fallback can.
 */
function writeHostTree(home) {
  const importOnly = { types: undefined, import: undefined };
  writePackage(
    home,
    '@earendil-works/pi-ai',
    {
      exports: {
        '.': { ...importOnly, import: './index.js' },
        './api/*': { ...importOnly, import: './api/*.js' },
      },
    },
    {
      'index.js':
        'export const InMemoryCredentialStore = class {};\n' +
        'export const defaultProviderAuthContext = () => ({});\n' +
        'export const envApiKeyAuth = () => ({});\n' +
        'export const createProvider = (config) => ({ config });\n',
      'api/anthropic-messages.lazy.js': 'export const anthropicMessagesApi = () => ({});\n',
      'api/openai-completions.lazy.js': 'export const openAICompletionsApi = () => ({});\n',
      'api/openai-responses.lazy.js': 'export const openAIResponsesApi = () => ({});\n',
    },
  );
  writePackage(home, '@deepseek-ai/dsh-llm-pi-ai', { exports: { '.': './index.js' } }, {
    'index.js':
      'export class PiAiAdapter {\n' +
      '  constructor(options) { this.options = options; }\n' +
      '  providerInfo(provider) {\n' +
      '    const profile = this.options.profiles().get(provider);\n' +
      '    return { id: provider, name: profile?.displayName ?? provider };\n' +
      '  }\n' +
      '}\n',
  });
  writePackage(home, '@deepseek-ai/dsh-llm', { exports: { '.': './index.js' } }, {
    'index.js':
      'export class LlmError extends Error {\n' +
      '  constructor(message, code) { super(message); this.code = code; }\n' +
      '}\n' +
      'export const assertUsableApiKey = (key) => key;\n' +
      'export const resolveRetryPolicy = () => ({});\n',
  });
  writePackage(home, '@deepseek-ai/dsh-credentials', { exports: { '.': './index.js' } }, {
    'index.js': 'export const isCredentialRefName = () => false;\nexport const credentialRef = (name) => name;\n',
  });
  writePackage(home, '@deepseek-ai/dsh-launch-environment', { exports: { '.': './index.js' } }, {
    'index.js': 'export const launchEnvironmentOf = () => ({ get: () => undefined });\n',
  });
  const anchorDir = join(home, 'host');
  mkdirSync(anchorDir, { recursive: true });
  const anchor = join(anchorDir, 'anchor.js');
  writeFileSync(anchor, '// createRequire anchor inside the fake host tree\n');
  return anchor;
}

/**
 * Build the host-shaped context: a rejecting llm seam, a settings service that
 * delivers a resolved value, and a fresh catalog cache so no test hits the net.
 */
function harness({ withSettings = true, providers } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-models-dev-boot-'));
  const anchor = writeHostTree(home);
  const cachePath = join(home, 'models.dev.json');
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), data: CATALOG }));
  process.env.DSH_HOME = home;
  process.argv[1] = anchor;

  const resolved = {
    modelsDevUrl: 'https://models.dev/api.json',
    refreshHours: 24,
    cachePath,
    providers:
      providers ?? {
        [ROUTE]: { source: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY', displayName: 'OpenCode Go (models.dev live)' },
      },
  };

  const sections = [];
  const adapters = [];
  const directories = [];
  const errors = [];

  const llm = {
    registerConfigurableProviders: (entries) => {
      if (entries.length === 0) {
        throw new Error('LlmError: a configurable-provider registration must declare at least one provider');
      }
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
      hooks.setSource(() => resolved);
      hooks.onChange();
    },
  };

  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
    llm,
    get: (name) => (name === 'settings' && withSettings ? settings : undefined),
    on: () => {},
    effect: () => {},
    inject: (_deps, callback) => {
      if (withSettings) callback({ settings });
    },
  };

  return { ctx, home, resolved, sections, adapters, directories, errors };
}

/** Wait until the plugin's own trace reports the bootstrap finished. */
async function waitForBootstrap(home, timeoutMs = 5000) {
  const tracePath = join(home, 'plugins', NS, 'bootstrap.log');
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = readFileSync(tracePath, 'utf8');
      if (/bootstrap: (done|FAILED)/.test(text)) return text;
    } catch {
      // the trace appears once apply() runs
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return text;
}

/** Import the plugin after DSH_HOME and the host anchor point at the harness. */
async function loadPlugin() {
  return import(new URL('../index.js', import.meta.url).href);
}

test('the host composition registers the routes and the settings section', async () => {
  const h = harness();
  const { apply } = await loadPlugin();
  apply(h.ctx, {}); // the bundle entry carries no config — providers come from settings
  const trace = await waitForBootstrap(h.home);

  assert.equal(h.errors.length, 0, `bootstrap logged errors: ${JSON.stringify(h.errors)}`);
  assert.deepEqual(h.sections, [NS], 'the settings section is installed exactly once');
  assert.ok(h.adapters.includes(ROUTE), `adapter routes: ${h.adapters.join(', ') || 'none'}`);
  assert.ok(h.directories.includes(ROUTE), `directory entries: ${h.directories.join(', ') || 'none'}`);
  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
});

test('a deployment with no configured routes is a no-op, not a fatal error', async () => {
  const h = harness({ providers: {} });
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  const trace = await waitForBootstrap(h.home);

  assert.equal(h.errors.length, 0, `bootstrap logged errors: ${JSON.stringify(h.errors)}`);
  assert.deepEqual(h.adapters, [], 'no adapter is registered without routes');
  assert.deepEqual(h.directories, [], 'the empty directory registration is withdrawn, not attempted');
  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
});

test('a missing settings service leaves the loader config in charge without crashing', async () => {
  const h = harness({ withSettings: false });
  const { apply } = await loadPlugin();
  apply(h.ctx, {});
  const trace = await waitForBootstrap(h.home);

  assert.equal(h.errors.length, 0, `bootstrap logged errors: ${JSON.stringify(h.errors)}`);
  assert.deepEqual(h.sections, [], 'no settings service means no section to install');
  assert.match(trace, /bootstrap: done/);
  assert.doesNotMatch(trace, /bootstrap: FAILED/);
});
