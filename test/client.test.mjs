// test/client.test.mjs — the browser half: loader format + the refresh seat.
//
// Regression: the client bundle concatenates each package's `client.js` as-is
// and evaluates it as ONE script, so the file has to self-register through
// `window.__ModuleLoader__.load({id, factory})` — raw ESM (`export` at the top
// level) is a syntax error there and takes the WHOLE client boot down with
// "Failed to load plugins" (2026-09-22, 0.1.5).
//
// The 0.1.7 surface contract, exercised against a stub DOM:
//   * the seat is a bare globe — the hover spin replaced the refresh arrow;
//   * hovering spins it 360° and leaving eases it back to rest;
//   * a click crossfades the globe into a loading spinner until the answer;
//   * the answer pops a toast: success with the counts, or an error card
//     carrying the host log and the stack trace.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

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

/* ----------------------------------------------------------------- stub DOM */

class FakeClassList {
  constructor(el) {
    this.el = el;
  }

  list() {
    return (this.el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  }

  write(list) {
    this.el.attrs.set('class', list.join(' '));
  }

  add(...names) {
    const list = this.list();
    for (const name of names) if (!list.includes(name)) list.push(name);
    this.write(list);
  }

  remove(...names) {
    this.write(this.list().filter((name) => !names.includes(name)));
  }

  contains(name) {
    return this.list().includes(name);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: '' };
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    child.parentElement = this;
    const at = ref === null || ref === undefined ? -1 : this.children.indexOf(ref);
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  remove() {
    const siblings = this.parentElement?.children;
    if (siblings === undefined) return;
    const at = siblings.indexOf(this);
    if (at !== -1) siblings.splice(at, 1);
    this.parentElement = null;
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  fire(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

/** Minimal selector matcher: tag, [attr], [attr="value"] and .class compounds. */
function matchesSelector(el, selector) {
  const parts = selector.match(/[a-zA-Z0-9-]+|\[[^\]]+\]|\.[\w-]+/g) ?? [];
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part.startsWith('[')) {
      const parsed = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (parsed === null) return false;
      const [, name, value] = parsed;
      if (!el.hasAttribute(name)) return false;
      if (value !== undefined && el.getAttribute(name) !== value) return false;
    } else if (part.startsWith('.')) {
      if (!el.classList.contains(part.slice(1))) return false;
    } else if (el.tagName !== part.toUpperCase()) {
      return false;
    }
  }
  return true;
}

function queryAll(root, selector) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** Concatenated text of a subtree (textContent of every node). */
function textOf(node) {
  let out = String(node.textContent ?? '');
  for (const child of node.children) out += ` ${textOf(child)}`;
  return out;
}

/** Concatenated markup of a subtree (innerHTML of every node). */
function markupOf(node) {
  let out = String(node.innerHTML ?? '');
  for (const child of node.children) out += markupOf(child);
  return out;
}

/**
 * Boot the client against a stub DOM and seat one capability panel.
 * `fetchImpl` is swappable per test; timers are captured, never scheduled.
 */
function boot() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const document = {
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => queryAll(head, selector)[0] ?? queryAll(body, selector)[0] ?? null,
    querySelectorAll: (selector) => [...queryAll(head, selector), ...queryAll(body, selector)],
  };

  const panel = new FakeElement('section');
  panel.setAttribute('data-dsh-plugin', 'model-capabilities');
  panel.setAttribute('data-dsh-part', 'panel');
  const header = new FakeElement('button');
  header.setAttribute('data-dsh-part', 'toggle');
  const chevron = new FakeElement('span');
  header.appendChild(chevron);
  panel.appendChild(header);
  body.appendChild(panel);

  const fetchCalls = [];
  const state = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, results: [] }) }) };
  const timers = [];
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { sandbox.__registered = spec; } } },
    document,
    fetch: (...args) => {
      fetchCalls.push(args);
      return state.fetchImpl(...args);
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  };
  runInNewContext(source, sandbox, { filename: 'client.js' });

  const spec = sandbox.__registered;
  assert.ok(spec, 'client.js registers with the module loader');
  spec.factory().apply({ effect() {} });

  return {
    document,
    header,
    fetchCalls,
    timers,
    setFetch(fn) {
      state.fetchImpl = fn;
    },
    seat: document.querySelector('[data-dsh-models-dev-refresh]'),
  };
}

/** One fetch answer shaped like the refresh endpoint's envelope. */
function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** Let the seat's async chain settle. */
async function drain() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------------------------------------------------------- the bare globe */

test('the refresh seat renders a bare globe — no refresh arrow', () => {
  const { seat } = boot();
  assert.ok(seat, 'the icon is seated in the capability panel header');
  const html = markupOf(seat);
  assert.match(html, /<svg/, 'an icon svg is rendered');
  assert.match(html, /<circle/, 'the globe body is there');
  assert.doesNotMatch(html, /fill="(?!none)/, 'no filled arrow head — the hover spin is the refresh affordance now');
});

test('the globe rotates 360deg on hover and eases back on leave', () => {
  const { document } = boot();
  const style = document.querySelector('style');
  assert.ok(style, 'the seat styles are injected');
  const css = style.textContent;
  assert.ok(css.includes('[data-dsh-models-dev-refresh]:hover'), 'a hover rule drives the spin');
  assert.match(css, /rotate\(360deg\)/, 'the hover spin is one full turn');
  assert.match(css, /transition:\s*transform\s+\.\d+s/, 'the glyph transitions its transform, so it eases back to rest on leave');
});

/* ------------------------------------------------------- loading morphing */

test('a click swaps the globe for the loading spinner until the refresh answers', async () => {
  const env = boot();
  let answer;
  env.setFetch(() => new Promise((resolve) => { answer = resolve; }));
  assert.equal(env.seat.classList.contains('is-busy'), false);

  env.seat.fire('click');
  assert.equal(env.seat.classList.contains('is-busy'), true, 'the seat is busy while the refresh runs');
  assert.ok(env.seat.querySelector('.dmd-globe'), 'the globe glyph is mounted');
  assert.ok(env.seat.querySelector('.dmd-spin'), 'the loading glyph is mounted');

  answer(response(200, { ok: true, results: [{ route: 'opencode-go', added: 0, updated: 1 }] }));
  await drain();
  assert.equal(env.seat.classList.contains('is-busy'), false, 'the seat rests again once the refresh answered');
});

test('the glyph swap crossfades and the loading glyph turns', () => {
  const { document } = boot();
  const css = document.querySelector('style').textContent;
  assert.match(css, /is-busy \.dmd-globe\{[^}]*opacity:\s*0/, 'the globe fades out while busy');
  assert.match(css, /is-busy \.dmd-spin\{[^}]*opacity:\s*1/, 'the loading glyph fades in while busy');
  assert.match(css, /transition:\s*opacity/, 'the swap is a smooth crossfade');
  assert.match(css, /animation:\s*dmd-rotate/, 'the loading glyph spins');
});

/* ------------------------------------------------------------- the toasts */

test('a finished refresh pops a success toast with the per-route counts', async () => {
  const env = boot();
  env.setFetch(async () => response(200, { ok: true, results: [{ route: 'opencode-go', added: 2, updated: 28 }], log: ['refresh: loading catalog'] }));

  env.seat.fire('click');
  await drain();

  const toast = env.document.querySelector('[data-dsh-models-dev-toast="ok"]');
  assert.ok(toast, 'a success toast is shown');
  const text = textOf(toast);
  assert.ok(text.includes('opencode-go: +2/~28'), `the counts are in the toast: ${text}`);
});

test('a failed refresh pops an error toast carrying the log and the stack trace', async () => {
  const env = boot();
  env.setFetch(async () => response(400, {
    ok: false,
    error: 'catalog exploded',
    stack: 'Error: catalog exploded\n    at load (sync.mjs:80:11)',
    log: ['refresh: loading catalog (force=true)'],
  }));

  env.seat.fire('click');
  await drain();

  const toast = env.document.querySelector('[data-dsh-models-dev-toast="error"]');
  assert.ok(toast, 'an error notification is shown');
  const text = textOf(toast);
  assert.ok(text.includes('catalog exploded'), `the failure message is in the toast: ${text}`);
  assert.ok(text.includes('at load (sync.mjs:80:11)'), 'the stack trace rides along');
  assert.ok(text.includes('refresh: loading catalog (force=true)'), 'the host log rides along');
});

test('a network failure still pops the error toast', async () => {
  const env = boot();
  env.setFetch(async () => {
    throw new Error('network down');
  });

  env.seat.fire('click');
  await drain();

  const toast = env.document.querySelector('[data-dsh-models-dev-toast="error"]');
  assert.ok(toast, 'an error notification is shown');
  assert.ok(textOf(toast).includes('network down'), 'the fetch failure is reported');
});

test("a refused route write pops the error toast with that route's stack", async () => {
  const env = boot();
  env.setFetch(async () => response(200, {
    ok: true,
    results: [{ route: 'zai', source: 'zai', error: 'write refused', stack: 'Error: write refused\n    at mutate (service.mjs:93:7)' }],
    log: ['refresh: catalog 30 providers (stale=false)'],
  }));

  env.seat.fire('click');
  await drain();

  const toast = env.document.querySelector('[data-dsh-models-dev-toast="error"]');
  assert.ok(toast, 'a route-level refusal is a failure too');
  const text = textOf(toast);
  assert.ok(text.includes('write refused'), `the refusal is in the toast: ${text}`);
  assert.ok(text.includes('at mutate (service.mjs:93:7)'), 'the route stack rides along');
});

test('the toast stack wears the class its stylesheet positions', async () => {
  // Regression (e2e 2026-09-22): the root carried only the data attribute, so
  // the fixed bottom-right placement never applied and the toast stack flowed
  // below the fold — invisible in the viewport.
  const env = boot();
  env.setFetch(async () => response(200, { ok: true, results: [{ route: 'zai', added: 0, updated: 1 }] }));

  env.seat.fire('click');
  await drain();

  const root = env.document.querySelector('[data-dsh-models-dev-toasts]');
  const toast = env.document.querySelector('[data-dsh-models-dev-toast="ok"]');
  assert.ok(root, 'the toast stack root exists');
  assert.ok(root.classList.contains('dmd-toasts'), 'the root wears the class its stylesheet targets');
  assert.ok(toast.classList.contains('dmd-toast'), 'the card wears its class too');
  const css = env.document.querySelector('style').textContent;
  assert.match(css, /\.dmd-toasts\{[^}]*position:\s*fixed/, 'the stack is placed fixed by its stylesheet');
});

test('a toast close button removes it', async () => {
  const env = boot();
  env.setFetch(async () => response(200, { ok: true, results: [{ route: 'zai', added: 0, updated: 1 }] }));

  env.seat.fire('click');
  await drain();

  const toast = env.document.querySelector('[data-dsh-models-dev-toast="ok"]');
  assert.ok(toast);
  toast.querySelector('[data-dsh-models-dev-dismiss]').fire('click');
  assert.equal(env.document.querySelector('[data-dsh-models-dev-toast="ok"]'), null, 'the toast is dismissed');
});

test('a toast removes itself once its timeout runs', async () => {
  const env = boot();
  env.setFetch(async () => response(200, { ok: true, results: [{ route: 'zai', added: 0, updated: 1 }] }));

  env.seat.fire('click');
  await drain();

  assert.ok(env.document.querySelector('[data-dsh-models-dev-toast="ok"]'));
  const dismissTimer = env.timers.filter((timer) => typeof timer.ms === 'number' && timer.ms > 0).at(-1);
  assert.ok(dismissTimer, 'the toast schedules its own dismissal');
  dismissTimer.fn();
  assert.equal(env.document.querySelector('[data-dsh-models-dev-toast="ok"]'), null, 'the toast is gone after its timeout');
});
