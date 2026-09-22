// client.js — the browser half: the "update models from models.dev API" button.
//
// The Models page's capability editor (the pi-ai family's provider-card
// extension) lets a user declare modalities and thinking levels per model by
// hand. This half adds one action to that editor's header: a globe-with-refresh
// icon that re-reads the living models.dev catalog for the provider and updates
// the rows in place — the manual counterpart of the host's automatic sweep.
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

        /** Globe with a refresh arc — the "update from the internet" glyph. */
        const ICON = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" aria-hidden="true" focusable="false">'
          + '<circle cx="7" cy="8" r="4.3" stroke="currentColor" stroke-width="1.1" />'
          + '<path d="M2.7 8h8.6M7 3.7c1.7 1.8 1.7 6.8 0 8.6M7 3.7c-1.7 1.8-1.7 6.8 0 8.6" stroke="currentColor" stroke-width="0.9" fill="none" />'
          + '<path d="M3 3.4a5.4 5.4 0 0 1 7.6 0.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" />'
          + '<path d="M10.9 2.2l0.6 2.6-2.7-0.2z" fill="currentColor" />'
          + '</svg>';

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

        /** Drive one refresh for the seated provider (or everything, when unknown). */
        async function refreshModels(seat, route) {
          if (seat.dataset.state === 'busy') return;
          seat.dataset.state = 'busy';
          seat.title = 'updating models from models.dev API…';
          try {
            const response = await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(route === undefined ? {} : { route }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
            seat.dataset.state = 'done';
            seat.title = `updated — ${summarize(body.results)}`;
          } catch (error) {
            seat.dataset.state = 'error';
            seat.title = `update failed: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            setTimeout(() => {
              if (seat.dataset.state !== 'busy') {
                seat.dataset.state = '';
                seat.title = TOOLTIP;
              }
            }, 4000);
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
          seat.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;margin-left:auto;padding:2px;border-radius:4px;cursor:pointer;color:inherit';
          seat.innerHTML = ICON;
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
          seatAll();
          const observer = new MutationObserver(() => seatAll());
          observer.observe(document.body, { childList: true, subtree: true });
          ctx.effect(() => () => {
            observer.disconnect();
            for (const seat of document.querySelectorAll(SEAT)) seat.remove();
          }, 'dsh-models-dev: refresh seats');
        }

        module.exports = { apply, inject };
        return module.exports;
      },
    });
  } catch { /* ignore */ }
})();
