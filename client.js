// client.js — the browser half: the "update models from models.dev API" button.
//
// The Models page's capability editor (the pi-ai family's provider-card
// extension) lets a user declare modalities and thinking levels per model by
// hand. This half adds one action to that editor's header: a bare globe that
// re-reads the living models.dev catalog for the provider and updates the rows
// in place — the manual counterpart of the host's automatic sweep.
//
// The interaction, as designed:
//   * the glyph is a bare globe — hovering spins it 360° and leaving eases it
//     back to rest (the spin replaced the old refresh arrow);
//   * a press crossfades the globe into a loading spinner for the round trip;
//   * the answer pops a toast: a success card with the per-route counts, or an
//     error card carrying the failure, the host log and the stack trace.
//
// The header is the capability panel's own toggle button
// (`section[data-dsh-plugin="model-capabilities"] > button[data-dsh-part="toggle"]`),
// so the icon is seated before its chevron as a focusable span: nested buttons
// are invalid HTML, and the span stops click propagation so pressing it does not
// also toggle the panel. React leaves unknown siblings in place across renders;
// a MutationObserver re-seats the icon when a re-render does remove it.
//
// The provider identity rides the panel's own props: the React fiber above the
// header carries `{provider: row}`, whose `provider` is the route key. When that
// cannot be read the button refreshes every hooked-up route instead.
//
// Shipped loader-ready: the client bundle concatenates each package's client.js
// into one script, so this file self-registers through __ModuleLoader__ and uses
// no module syntax (a top-level `export` is a syntax error there and takes the
// whole client boot down).
;(function () {
  let load = null;
  try {
    if (typeof window !== 'undefined' && window && typeof window.__ModuleLoader__ === 'object') {
      load = window.__ModuleLoader__.load.bind(window.__ModuleLoader__);
    }
  } catch { load = null; }
  if (!load) return;
  try {
    load({
      id: 'dsh-models-dev',
      factory: () => {
        const module = { exports: {} };
        const TOOLTIP = 'update models from models.dev API';
        const REFRESH_PATH = '/api/dsh-models-dev/refresh';
        const PANEL = 'section[data-dsh-plugin="model-capabilities"][data-dsh-part="panel"]';
        const HEADER = 'button[data-dsh-part="toggle"]';
        const SEAT = '[data-dsh-models-dev-refresh]';
        const STYLE = '[data-dsh-models-dev-style]';
        const TOASTS = '[data-dsh-models-dev-toasts]';
        const TOAST = '[data-dsh-models-dev-toast]';
        const SUCCESS_MS = 6000;
        const ERROR_MS = 14000;

        /** A bare globe — the hover spin is the refresh affordance now. */
        const GLOBE = '<svg viewBox="0 0 14 14" width="13" height="13" fill="none" aria-hidden="true" focusable="false">'
          + '<circle cx="7" cy="7" r="5.4" stroke="currentColor" stroke-width="1" fill="none" />'
          + '<path d="M1.6 7h10.8M7 1.6c2 2.2 2 8.6 0 10.8M7 1.6c-2 2.2-2 8.6 0 10.8" stroke="currentColor" stroke-width="0.9" fill="none" />'
          + '</svg>';

        /** The loading glyph the globe crossfades into while the refresh runs. */
        const SPIN = '<svg viewBox="0 0 14 14" width="13" height="13" fill="none" aria-hidden="true" focusable="false">'
          + '<circle cx="7" cy="7" r="5.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="22 12" stroke-linecap="round" fill="none" />'
          + '</svg>';

        const CSS = [
          '[data-dsh-models-dev-refresh]{position:relative;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:auto;padding:2px;border-radius:4px;cursor:pointer;color:inherit}',
          '[data-dsh-models-dev-refresh] .dmd-globe{display:inline-flex;transition:transform .6s ease,opacity .18s ease}',
          '[data-dsh-models-dev-refresh]:hover .dmd-globe{transform:rotate(360deg)}',
          '[data-dsh-models-dev-refresh] .dmd-spin{position:absolute;inset:0;display:inline-flex;align-items:center;justify-content:center;opacity:0;transform:scale(.5);transition:opacity .18s ease,transform .18s ease;pointer-events:none}',
          '[data-dsh-models-dev-refresh].is-busy .dmd-globe{opacity:0;transform:scale(.5)}',
          '[data-dsh-models-dev-refresh].is-busy .dmd-spin{opacity:1;transform:scale(1)}',
          '[data-dsh-models-dev-refresh].is-busy .dmd-spin svg{animation:dmd-rotate .9s linear infinite}',
          '@keyframes dmd-rotate{to{transform:rotate(360deg)}}',
          '.dmd-toasts{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:340px;max-width:calc(100vw - 32px);pointer-events:none}',
          '.dmd-toast{pointer-events:auto;background:var(--dsw-alias-toast-bg,#292929);color:var(--dsw-alias-neutral-00,#fff);border:1px solid var(--dsw-alias-border-l1,#3c3c3d);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,.35);animation:dmd-toast-in .18s ease}',
          '.dmd-toast.ok{border-color:var(--dsw-alias-state-success-primary,#22c55e)}',
          '.dmd-toast.error{border-color:var(--dsw-alias-state-danger-primary,#ef4444)}',
          '.dmd-toast-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
          '.dmd-toast-close{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;opacity:.7}',
          '.dmd-toast-close:hover{opacity:1}',
          '.dmd-toast pre{max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:6px 0 0;padding:6px;background:rgba(0,0,0,.25);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}',
          '@keyframes dmd-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
        ].join('\n');

        /** The route key the seated panel belongs to, read off its React props. */
        function routeOf(node) {
          for (let el = node; el !== null; el = el.parentElement) {
            for (const key of Object.keys(el)) {
              if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
              for (let fiber = el[key], depth = 0; fiber !== undefined && fiber !== null && depth < 40; depth += 1, fiber = fiber.return) {
                const provider = fiber.memoizedProps && fiber.memoizedProps.provider;
                if (provider !== undefined && provider !== null && typeof provider.provider === 'string') return provider.provider;
              }
            }
          }
          return undefined;
        }

        /** One human-readable summary of a sweep: counts per route, or the reason. */
        function summarize(results) {
          return (results || [])
            .map((result) => (result.added === undefined ? `${result.route}: ${result.skipped || result.error}` : `${result.route}: +${result.added}/~${result.updated}`))
            .join(', ');
        }

        /** Seat the seat + toast styles once per document. */
        function injectStyles() {
          if (document.querySelector(STYLE) !== null) return;
          const style = document.createElement('style');
          style.setAttribute('data-dsh-models-dev-style', '');
          style.textContent = CSS;
          document.head.appendChild(style);
        }

        /** The frame-wide toast stack (fixed, above the settings modal). */
        function toastsRoot() {
          let root = document.querySelector(TOASTS);
          if (root === null) {
            root = document.createElement('div');
            root.setAttribute('data-dsh-models-dev-toasts', '');
            root.setAttribute('class', 'dmd-toasts');
            document.body.appendChild(root);
          }
          return root;
        }

        /**
         * Pop one toast: `ok` carries the summary, `error` carries the failure
         * with the host log and the stack trace in scrollable monospace blocks.
         */
        function showToast(kind, { title, detail, log = [], stack = '' }) {
          const card = document.createElement('div');
          card.setAttribute('data-dsh-models-dev-toast', kind);
          card.setAttribute('class', `dmd-toast ${kind}`);
          card.setAttribute('role', kind === 'error' ? 'alert' : 'status');

          const head = document.createElement('div');
          head.setAttribute('class', 'dmd-toast-head');
          const strong = document.createElement('strong');
          strong.textContent = title;
          const close = document.createElement('button');
          close.setAttribute('data-dsh-models-dev-dismiss', '');
          close.setAttribute('class', 'dmd-toast-close');
          close.setAttribute('aria-label', 'dismiss');
          close.textContent = '\u00d7';
          const dismiss = () => card.remove();
          close.addEventListener('click', dismiss);
          head.appendChild(strong);
          head.appendChild(close);
          card.appendChild(head);

          const detailEl = document.createElement('div');
          detailEl.textContent = detail;
          card.appendChild(detailEl);
          if (log.length > 0) {
            const pre = document.createElement('pre');
            pre.textContent = log.join('\n');
            card.appendChild(pre);
          }
          if (stack !== '') {
            const pre = document.createElement('pre');
            pre.textContent = stack;
            card.appendChild(pre);
          }

          toastsRoot().appendChild(card);
          setTimeout(dismiss, kind === 'error' ? ERROR_MS : SUCCESS_MS);
        }

        /** Drive one refresh for the seated provider (or everything, when unknown). */
        async function refreshModels(seat, route) {
          if (seat.classList.contains('is-busy')) return;
          seat.classList.add('is-busy');
          seat.dataset.state = 'busy';
          seat.title = 'updating models from models.dev API\u2026';
          try {
            const response = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(route === undefined ? {} : { route }),
            });
            const body = await response.json().catch(() => ({}));
            const routeErrors = (body.results ?? []).filter((result) => result !== null && typeof result === 'object' && result.error !== undefined);
            const log = Array.isArray(body.log) ? body.log : [];
            if (!response.ok || body.ok !== true || routeErrors.length > 0) {
              const message = body.error || routeErrors.map((result) => `${result.route}: ${result.error}`).join('; ') || `HTTP ${response.status}`;
              const stack = body.stack || routeErrors.map((result) => result.stack || '').filter(Boolean).join('\n\n');
              seat.dataset.state = 'error';
              seat.title = `update failed: ${message}`;
              showToast('error', { title: 'Model update failed', detail: message, log, stack });
              return;
            }
            seat.dataset.state = 'done';
            seat.title = `updated \u2014 ${summarize(body.results)}`;
            showToast('ok', { title: 'Models updated', detail: summarize(body.results) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            seat.dataset.state = 'error';
            seat.title = `update failed: ${message}`;
            showToast('error', {
              title: 'Model update failed',
              detail: message,
              stack: error instanceof Error ? (error.stack ?? '') : '',
            });
          } finally {
            seat.classList.remove('is-busy');
          }
        }

        /** Seat one icon in the panel header; no-op when one is already there. */
        function seatIcon(header) {
          if (header.querySelector(SEAT) !== null) return;
          const seat = document.createElement('span');
          seat.setAttribute('data-dsh-models-dev-refresh', '');
          seat.setAttribute('role', 'button');
          seat.setAttribute('tabindex', '0');
          seat.setAttribute('aria-label', TOOLTIP);
          seat.title = TOOLTIP;
          const globe = document.createElement('span');
          globe.setAttribute('class', 'dmd-globe');
          globe.innerHTML = GLOBE;
          const spin = document.createElement('span');
          spin.setAttribute('class', 'dmd-spin');
          spin.innerHTML = SPIN;
          seat.appendChild(globe);
          seat.appendChild(spin);
          const act = (event) => {
            event.preventDefault();
            event.stopPropagation();
            void refreshModels(seat, routeOf(header));
          };
          seat.addEventListener('click', act);
          seat.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') act(event);
          });
          // Right before the chevron (the header's last child) — the action seat.
          header.insertBefore(seat, header.lastElementChild);
        }

        /** Seat every header currently on the page. */
        function seatAll() {
          for (const panel of document.querySelectorAll(PANEL)) {
            const header = panel.querySelector(HEADER);
            if (header !== null) seatIcon(header);
          }
        }

        const inject = [];

        /** Client plugin body: keep the icon seated wherever a panel exists. */
        function apply(ctx) {
          injectStyles();
          seatAll();
          const observer = new MutationObserver(() => seatAll());
          observer.observe(document.body, { childList: true, subtree: true });
          ctx.effect(() => () => {
            observer.disconnect();
            for (const seat of document.querySelectorAll(SEAT)) seat.remove();
            for (const toast of document.querySelectorAll(TOAST)) toast.remove();
          }, 'dsh-models-dev: refresh seats');
        }

        module.exports = { apply, inject };
        return module.exports;
      },
    });
  } catch { /* ignore */ }
})();
