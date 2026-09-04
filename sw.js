/* Sporelo service worker — hand-written, ~80 lines, no workbox (ARCHITECTURE.md §1.6).
   A plugin's defaults actively fight the one behaviour that matters here: never swapping
   the app shell under a live scoring session. See §5 I8. */

// Bump on every deploy. This is the ONLY cache-invalidation mechanism, because the build
// emits deterministic (unhashed) filenames so that the precache list below can be static.
const CACHE_VERSION = 'sporelo-v6';
const BASE = '/sporelo-app/';

// Explicit precache list. Never a runtime-discovered URL, never a cross-origin request —
// there are none, and adding one would be a scope change (SCOPE: no server, no network).
// Verified against a real `vite build` on 2026-08-12 — dist/ emits exactly these paths.
// If the build output ever changes, this list must change with it or offline boot fails
// silently, which is the worst failure mode this app has.
const PRECACHE = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.webmanifest`,
  `${BASE}assets/index.js`,
  `${BASE}assets/index.css`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
  `${BASE}fonts/Archivo-Variable.woff`,
  // The card renderer draws these. A card that cannot load its own logo offline is the
  // one artefact the growth hook depends on, so they are precached like the app shell.
  `${BASE}brand/mark.svg`,
  `${BASE}brand/wordmark.svg`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // cache: 'reload' bypasses GitHub Pages' own HTTP cache, which otherwise serves a
      // stale shell into a brand-new service worker.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res.ok) await cache.put(url, res);
          } catch {
            // One missing optional asset must not abort the whole install and leave the
            // app with no offline capability at all.
          }
        }),
      );
      // Deliberately NOT calling skipWaiting(). A new version activates on the next cold
      // start. Swapping the shell mid-match is a data-integrity hazard, not a freshness win.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Same-origin GET only. Anything else is passed straight through untouched.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;

  // Navigations: NETWORK-FIRST with a short timeout, falling back to cache.
  //
  // This was cache-first, and that was wrong in a way that took a deploy to discover: a
  // device that installed the app once served that first shell forever, because the cached
  // index.html always won and the waiting worker only activates when every tab closes.
  // Deploys could not reach anyone who had already installed.
  //
  // Network-first keeps the offline guarantee (the cache is still the fallback) while
  // making a fresh shell reachable the moment there is signal. The 2.5s timeout is the
  // courtside case: on bad signal, waiting on a dead request is worse than the last known
  // good app, and SCOPE's offline requirement is about the app working, not about it
  // being stale.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(`${BASE}index.html`);
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          const res = await fetch(request, { signal: controller.signal });
          clearTimeout(timer);
          if (res && res.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(`${BASE}index.html`, res.clone());
            return res;
          }
        } catch {
          // Offline, or the network took too long. The cache is the point of this worker.
        }
        if (cached) return cached;
        return new Response('Offline and no cached copy of the app is available.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      })(),
    );
    return;
  }

  // The build emits UNHASHED filenames, so assets/index.js is a stable URL whose contents
  // change every deploy. Cache-first would pin the bundle exactly the way it pinned the
  // shell. Fonts, icons and the brand SVGs genuinely never change under a fixed name, so
  // they stay cache-first — that is where the offline speed actually matters.
  const isVolatile = url.pathname.startsWith(`${BASE}assets/`);

  event.respondWith(
    (async () => {
      if (!isVolatile) {
        const cached = await caches.match(request);
        if (cached) return cached;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(request, { signal: controller.signal });
        clearTimeout(timer);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(request, res.clone());
          return res;
        }
      } catch {
        // fall through to whatever we have
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      return new Response('', { status: 504 });
    })(),
  );
});

// The page asks for an update only when it knows no match is in progress (§5 I8).
self.addEventListener('message', (event) => {
  if (event.data === 'SPORELO_APPLY_UPDATE') self.skipWaiting();
});
