/**
 * Filament Service Worker (#6)
 *
 * Caches the app shell and static assets only. The fetch handler
 * deliberately passes through anything that carries device state:
 *
 *  - /api/v1/devices*      device list/state polls (10s), incl.
 *                          PUT /api/v1/devices/{ref}/active-mode — the
 *                          ledger-correction route, which writes the local
 *                          record of what we commanded and sends nothing
 *                          to the light (CLAUDE.md:391-393). Serving a
 *                          cached copy would assert a stale mode.
 *  - /api/v1/effects*      effect library + playing polls (3s).
 *
 * Contract asserted by src/lib/sw.test.ts (CI gate).
 */

const CACHE_NAME = "filament-shell-v1";
const STATIC_ASSETS = ["/", "/manifest.webmanifest"];

// Routes that must NEVER be served from the cache.
const NEVER_CACHE_PATTERNS = [
  /^\/api\/v1\/devices/, // includes .../active-mode by prefix
  /^\/api\/v1\/devices\/.*\/active-mode/, // explicit: ledger correction
  /^\/api\/v1\/effects/,
];

function shouldCache(request) {
  const url = new URL(request.url);
  // Only ever cache same-origin GETs.
  if (request.method !== "GET") return false;
  if (url.origin !== location.origin) return false;
  for (const pattern of NEVER_CACHE_PATTERNS) {
    if (pattern.test(url.pathname)) return false;
  }
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url))),
      ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!shouldCache(request)) return; // straight to the network

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: serve the shell fast, refresh in background.
        event.waitUntil(
          fetch(request)
            .then((response) => {
              if (response && response.ok) {
                caches
                  .open(CACHE_NAME)
                  .then((cache) => cache.put(request, response));
              }
            })
            .catch(() => {}),
        );
        return cached;
      }
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }),
  );
});
