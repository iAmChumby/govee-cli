/**
 * Filament Service Worker (#6)
 *
 * Caches the app shell and static assets only. The cache is an ALLOWLIST:
 * a request is cached only if its path is one of the shell/static shapes
 * below. Everything else — most importantly every sidecar route under
 * `/api/`, and every Next.js flight (RSC) request — goes straight to the
 * network.
 *
 * Why not a denylist: the previous version listed only
 * `/api/v1/devices*` and `/api/v1/effects*`, so every other same-origin API
 * GET was cached by default — `/health` (scheduler owner, crontab),
 * `/schedules`, `/schedules/external` (wake-ramp armed), `/meter`, `/rooms`,
 * `/groups`, `/config/cities`, and any route added later. An installed PWA
 * then opened showing stale state, which claims something the sidecar
 * cannot currently confirm (CLAUDE.md's honesty rule).
 *
 * Contract asserted by src/lib/sw.test.ts (CI gate), which extracts every
 * path in src/lib/api.ts and proves none of them is ever cached.
 */

const CACHE_NAME = "filament-shell-v2";
const STATIC_ASSETS = ["/", "/manifest.webmanifest"];

/**
 * The only path shapes that may be served from (or written to) the cache:
 * the shell document, the manifest, Next's immutable build output, the
 * installed icons, and the favicon.
 */
function isShellOrStatic(pathname) {
  if (pathname === "/") return true;
  if (pathname === "/manifest.webmanifest") return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname.startsWith("/icons/")) return true;
  return false;
}

/**
 * Next.js App Router flight (RSC) requests.
 *
 * A client-side navigation asks the server for the *flight payload* rather
 * than a document: the URL carries `?_rsc=<hash>` and the request carries
 * an `RSC: 1` header. The path is the same path the shell is cached under
 * (`/`, `/device/<ref>`), so the allowlist below cannot tell them apart
 * by pathname alone — and a cached flight payload is a cached page whose
 * server-rendered state is frozen at cache time.
 *
 * Today every page in this app is a client component, so the payload is
 * module references and nothing stale ships; that is a property of the
 * current pages, not of the cache contract, so the contract says no.
 */
function isRscRequest(request, url) {
  if (url.searchParams.has("_rsc")) return true;
  // `headers` is absent in the unit test's plain objects and present on a
  // real Request; both must be safe to read.
  const headers = request.headers;
  if (!headers || typeof headers.get !== "function") return false;
  return headers.get("RSC") === "1";
}

function shouldCache(request) {
  const url = new URL(request.url);
  // Only ever cache same-origin GETs.
  if (request.method !== "GET") return false;
  if (url.origin !== location.origin) return false;
  // Belt and braces: the API is state, never shell — whatever else says.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return false;
  // A flight payload is state too: the same path, a different document.
  if (isRscRequest(request, url)) return false;
  return isShellOrStatic(url.pathname);
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
