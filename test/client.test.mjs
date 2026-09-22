// test/client.test.mjs — the browser half must ship loader-ready.
//
// Regression: the client bundle concatenates each package's `client.js` as-is
// and evaluates it as ONE script, so the file has to self-register through
// `window.__ModuleLoader__.load({id, factory})` — raw ESM (`export` at the top
// level) is a syntax error there and takes the WHOLE client boot down with
// "Failed to load plugins" (2026-09-22, 0.1.5).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('client.js self-registers with the module loader under its package id', () => {
  assert.match(source, /__ModuleLoader__\.load/, 'the loader registration is present');
  assert.match(source, /id:\s*['"]dsh-models-dev['"]/, 'registered as dsh-models-dev');
  assert.match(source, /module\.exports\s*=\s*\{\s*apply,\s*inject\s*\}/, 'exports apply + inject');
});

test('client.js carries no module syntax the concatenated bundle chokes on', () => {
  assert.doesNotMatch(source, /^\s*export\s/m, 'no top-level export statements');
  assert.doesNotMatch(source, /^\s*import\s/m, 'no top-level import statements');
  assert.doesNotMatch(source, /\brequire\s*\(\s*['"]react/, 'no bare requires of host-bundled libs');
});
