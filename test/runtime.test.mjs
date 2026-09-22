// test/runtime.test.mjs — host-module resolution against import-only exports maps.
//
// Regression for the bootstrap failure that kept dsh-models-dev out of the
// Host settings seam: require.resolve() applies the `require` condition only,
// so a package whose exports map declares `import` alone (pi-ai 0.85.x) made
// loadHostModules() throw ERR_PACKAGE_PATH_NOT_EXPORTED — before the plugin
// registered its settings section or served any route.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadHostModules, resolveForImport } from '../lib/runtime.mjs';

/** A fixture package shaped like pi-ai: exports carry `types` + `import`, never `require`. */
function esmOnlyTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-models-dev-runtime-'));
  const dir = join(root, 'node_modules', '@fixture', 'esm-only');
  mkdirSync(join(dir, 'dist', 'api'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@fixture/esm-only',
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './api/*': { types: './dist/api/*.d.ts', import: './dist/api/*.js' },
      },
    }),
  );
  writeFileSync(join(dir, 'dist', 'index.js'), 'export const marker = "root";\n');
  writeFileSync(join(dir, 'dist', 'api', 'thing.lazy.js'), 'export const marker = "lazy";\n');
  writeFileSync(join(root, 'anchor.js'), '// require anchor inside the fixture tree\n');
  return { root, anchor: join(root, 'anchor.js') };
}

/** A fixture package Node resolves the ordinary way, through `main`. */
function requireCapableTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-models-dev-runtime-cjs-'));
  const dir = join(root, 'node_modules', '@fixture', 'cjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@fixture/cjs', version: '1.0.0', main: './index.js' }));
  writeFileSync(join(dir, 'index.js'), 'module.exports = { marker: "cjs" };\n');
  writeFileSync(join(root, 'anchor.js'), '// require anchor inside the fixture tree\n');
  return { root, anchor: join(root, 'anchor.js') };
}

/** The running dsh entry point, when this machine has one. */
function liveAnchor() {
  const candidates = [
    process.env.DSH_MODELS_DEV_DSH_BIN,
    'C:/Users/admin/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && existsSync(candidate));
}

test('require.resolve cannot see an import-only exports map (the bug being fixed)', () => {
  const { anchor } = esmOnlyTree();
  const require_ = createRequire(anchor);
  assert.throws(() => require_.resolve('@fixture/esm-only'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.throws(() => require_.resolve('@fixture/esm-only/api/thing.lazy'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('resolveForImport falls back to the exports map for an ESM-only package', async () => {
  const { anchor } = esmOnlyTree();
  const require_ = createRequire(anchor);
  const root = await import(resolveForImport(require_, '@fixture/esm-only').href);
  const lazy = await import(resolveForImport(require_, '@fixture/esm-only/api/thing.lazy').href);
  assert.equal(root.marker, 'root');
  assert.equal(lazy.marker, 'lazy');
});

test('resolveForImport keeps require.resolve as the first strategy', () => {
  const { anchor } = requireCapableTree();
  const require_ = createRequire(anchor);
  assert.equal(resolveForImport(require_, '@fixture/cjs').href, pathToFileURL(require_.resolve('@fixture/cjs')).href);
});

test('resolveForImport propagates a genuinely missing package', () => {
  const { anchor } = esmOnlyTree();
  const require_ = createRequire(anchor);
  assert.throws(() => resolveForImport(require_, '@fixture/missing'), { code: 'MODULE_NOT_FOUND' });
});

test('resolveForImport refuses a subpath the exports map does not declare', () => {
  const { anchor } = esmOnlyTree();
  const require_ = createRequire(anchor);
  assert.throws(() => resolveForImport(require_, '@fixture/esm-only/internal/secret'), /does not export/);
});

test('loadHostModules resolves pi-ai through its import-only exports (live dsh)', async (t) => {
  const anchor = liveAnchor();
  if (anchor === undefined) return t.skip('no dsh checkout on this machine');

  const mods = await loadHostModules({ anchor });
  assert.equal(typeof mods.piAi.createProvider, 'function');
  assert.equal(typeof mods.piAi.InMemoryCredentialStore, 'function');
  assert.equal(typeof mods.llmPiAi.PiAiAdapter, 'function');
  assert.equal(typeof mods.anthropicApi.anthropicMessagesApi, 'function');
  assert.equal(typeof mods.completionsApi.openAICompletionsApi, 'function');
  assert.equal(typeof mods.responsesApi.openAIResponsesApi, 'function');
});
