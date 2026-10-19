import assert from "node:assert/strict";
import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * #6 — Service Worker cache contract (CI gate).
 *
 * The worker's real `shouldCache` is executed here (node:vm, with stubs for
 * the worker globals), then every path src/lib/api.ts can call is fed to it.
 * The API is an allowlist-by-omission contract: any route under `/api/` is
 * uncached, including routes that do not exist yet. That makes a revert to
 * the old denylist (`NEVER_CACHE_PATTERNS`) fail this file: `/api/v1/health`
 * and `/api/v1/schedules` would start returning true.
 */

const ORIGIN = "https://filament.test";

function readAppFile(...parts: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf8");
}

const swSource = readAppFile("public/sw.js");
const apiSource = readAppFile("src/lib/api.ts");

const CACHE_NAME = "filament-shell-v3";

interface CacheRequest {
  method: string;
  url: string;
  /** a real Request has headers; the plain objects above do not */
  headers?: { get(name: string): string | null };
}

type Listener = (event: { waitUntil(promise: Promise<unknown>): void }) => void;

interface WorkerOptions {
  /** URLs already in the current cache */
  cacheUrls?: string[];
  /** cache names `caches.keys()` reports */
  cacheKeys?: string[];
  /** body of the fresh `/` document the activate handler fetches */
  shellHtml?: string;
  /**
   * URLs the current build still serves. A HEAD for any of these answers
   * 200; every other URL answers 404 ("the last deploy's file"). Unset
   * means the server serves everything.
   */
  servedUrls?: string[];
  /** every network request fails — an activate while the device is offline */
  offline?: boolean;
}

interface Worker {
  context: Record<string, unknown>;
  listeners: Record<string, Listener[]>;
  deletedCacheNames: string[];
  deletedUrls: string[];
}

/** Execute public/sw.js with the worker globals the code touches. */
function loadWorker(options: WorkerOptions = {}): Worker {
  const deletedCacheNames: string[] = [];
  const deletedUrls: string[] = [];
  const listeners: Record<string, Listener[]> = {};
  const cache = {
    keys: async () => (options.cacheUrls ?? []).map((url) => ({ url })),
    delete: async (url: string) => {
      deletedUrls.push(url);
      return true;
    },
    add: async () => undefined,
    put: async () => undefined,
  };
  const context: Record<string, unknown> = {
    location: { origin: ORIGIN },
    self: {
      addEventListener: (type: string, listener: Listener) => {
        (listeners[type] ??= []).push(listener);
      },
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    },
    caches: {
      open: async () => cache,
      match: async () => undefined,
      keys: async () => options.cacheKeys ?? [CACHE_NAME],
      delete: async (key: string) => {
        deletedCacheNames.push(key);
        return true;
      },
    },
    fetch: async (url: string, init?: { method?: string }) => {
      if (options.offline) throw new Error("offline");
      const target = String(url);
      // A HEAD is how the activate handler asks the server whether a
      // cached build asset is still part of the current build.
      if (init && init.method === "HEAD") {
        const served = !options.servedUrls || options.servedUrls.includes(target);
        return {
          ok: served,
          status: served ? 200 : 404,
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => options.shellHtml ?? "",
      };
    },
    URL,
    console,
  };
  vm.createContext(context);
  vm.runInContext(swSource, context, { filename: "public/sw.js" });
  return { context, listeners, deletedCacheNames, deletedUrls };
}

function loadShouldCache(): (request: CacheRequest) => boolean {
  const fn = loadWorker().context.shouldCache;
  assert.equal(typeof fn, "function", "public/sw.js must define shouldCache()");
  return fn as (request: CacheRequest) => boolean;
}

const shouldCache = loadShouldCache();

/**
 * Every pathname src/lib/api.ts can request. Comments are stripped first:
 * the prose contains backticked words ("`mode`/...") whose closing backtick
 * followed by "/" would otherwise be read as a path. Template
 * interpolations become their literal prefix, query strings are dropped,
 * and relative paths get the `/api/v1` base `request()` prepends.
 */
function apiPathnames(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const literals = [...code.matchAll(/["'`](\/[^"'`\n]*)/g)].map((m) => m[1]);
  const paths = literals
    .map((literal) => literal.split("${")[0])
    .map((literal) => literal.split("?")[0])
    .filter((literal) => literal.startsWith("/"))
    .map((literal) =>
      literal.startsWith("/api/") ? literal : `/api/v1${literal}`,
    );
  return [...new Set(paths)];
}

const apiPaths = apiPathnames(apiSource);

describe("Service Worker cache contract (#6)", () => {
  it("extracts the API routes from api.ts (the gate cannot pass vacuously)", () => {
    assert.ok(
      apiPaths.length >= 20,
      `expected >=20 API paths from src/lib/api.ts, got ${apiPaths.length}`,
    );
    // The state routes the defect exposed must all be in the extracted set.
    for (const route of [
      "/api/v1/health",
      "/api/v1/schedules",
      "/api/v1/schedules/external",
      "/api/v1/meter",
      "/api/v1/rooms",
      "/api/v1/groups",
      "/api/v1/config/cities",
    ]) {
      assert.ok(apiPaths.includes(route), `api.ts extraction missed ${route}`);
    }
  });

  it("never caches any GET route api.ts can call", () => {
    for (const pathname of apiPaths) {
      assert.equal(
        shouldCache({ method: "GET", url: `${ORIGIN}${pathname}` }),
        false,
        `${pathname} must never be served from the cache`,
      );
    }
  });

  it("never caches API calls under any method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const pathname of apiPaths) {
        assert.equal(
          shouldCache({ method, url: `${ORIGIN}${pathname}` }),
          false,
          `${method} ${pathname} must never be served from the cache`,
        );
      }
    }
  });

  it("keeps unknown and future API routes uncached too", () => {
    for (const pathname of [
      "/api/v1",
      "/api/v1/",
      "/api/v1/health/extra",
      "/api/v1/route-added-later",
      "/api",
      "/api/anything",
    ]) {
      assert.equal(
        shouldCache({ method: "GET", url: `${ORIGIN}${pathname}` }),
        false,
        `${pathname} must not be cached — the contract is an allowlist`,
      );
    }
    // Revert guard: the denylist implementation must not come back.
    assert.doesNotMatch(swSource, /NEVER_CACHE_PATTERNS/);
  });

  it("caches the shell and static assets only", () => {
    for (const pathname of [
      "/",
      "/manifest.webmanifest",
      "/favicon.ico",
      "/_next/static/chunks/app.js",
      "/icons/icon-192.png",
      "/icons/icon-512-maskable.png",
    ]) {
      assert.equal(
        shouldCache({ method: "GET", url: `${ORIGIN}${pathname}` }),
        true,
        `${pathname} should be cached`,
      );
    }
  });

  it("is GET-only and same-origin", () => {
    assert.equal(shouldCache({ method: "PUT", url: `${ORIGIN}/` }), false);
    assert.equal(
      shouldCache({ method: "GET", url: "https://other.example/" }),
      false,
    );
  });

  it("never caches a Next.js flight (RSC) request", () => {
    // The flight payload rides the same path as the shell document, so
    // the allowlist cannot tell the two apart by pathname. Next.js marks
    // it two ways: `?_rsc=<hash>` on the URL, and an `RSC: 1` header.
    for (const pathname of ["/", "/device/Shelf%20Lamp", "/settings"]) {
      assert.equal(
        shouldCache({
          method: "GET",
          url: `${ORIGIN}${pathname}?_rsc=1a2b3c`,
        }),
        false,
        `${pathname}?_rsc=… must never be served from the cache`,
      );
      assert.equal(
        shouldCache({
          method: "GET",
          url: `${ORIGIN}${pathname}`,
          headers: { get: (name) => (name === "RSC" ? "1" : null) },
        }),
        false,
        `${pathname} with an RSC: 1 header must never be served from the cache`,
      );
    }
  });

  it("still caches the shell when the request is not a flight payload", () => {
    // The header check is exactly `RSC: 1` — a request without it, or
    // with another value, is the document and stays cacheable.
    assert.equal(
      shouldCache({
        method: "GET",
        url: `${ORIGIN}/`,
        headers: { get: () => null },
      }),
      true,
    );
    assert.equal(
      shouldCache({
        method: "GET",
        url: `${ORIGIN}/?tab=scenes`,
        headers: { get: () => null },
      }),
      true,
      "an ordinary query string is not a flight payload",
    );
  });

  it("keeps the current build's chunks and fonts, and drops the last build's", async () => {
    // A route chunk the shell document never names: only that route's own
    // document names it, and the old rule read one document.
    const settingsChunk = `${ORIGIN}/_next/static/chunks/app/settings/page-abc123.js`;
    // The fonts are named by the CSS, not by any document.
    const font = `${ORIGIN}/_next/static/media/9f8e7d6c.woff2`;
    // The previous deploy's chunk: the server no longer has it.
    const previousBuild = `${ORIGIN}/_next/static/chunks/old-9f8e7d.js`;

    const worker = loadWorker({
      cacheUrls: [
        settingsChunk,
        font,
        previousBuild,
        `${ORIGIN}/`,
        `${ORIGIN}/icons/icon-192.png`,
      ],
      cacheKeys: [CACHE_NAME, "filament-shell-v2"],
      servedUrls: [settingsChunk, font],
    });
    const handler = worker.listeners.activate?.[0];
    assert.ok(handler, "public/sw.js must register an activate handler");
    const waits: Promise<unknown>[] = [];
    handler({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);

    assert.deepEqual(worker.deletedCacheNames, ["filament-shell-v2"]);
    // The current build's own assets survive, whatever route they belong to.
    assert.equal(
      worker.deletedUrls.includes(settingsChunk),
      false,
      "the current build's /settings chunk must survive activation",
    );
    assert.equal(
      worker.deletedUrls.includes(font),
      false,
      "the current build's font must survive activation",
    );
    // The previous deploy's chunk is gone.
    assert.deepEqual(worker.deletedUrls, [previousBuild]);
    // The shell and the icons are not build output and are never evicted.
    assert.equal(worker.deletedUrls.includes(`${ORIGIN}/`), false);
    assert.equal(
      worker.deletedUrls.includes(`${ORIGIN}/icons/icon-192.png`),
      false,
    );
  });

  it("keeps every cached build chunk when the server cannot be reached", async () => {
    const chunk = `${ORIGIN}/_next/static/chunks/keep.js`;
    const worker = loadWorker({
      cacheUrls: [chunk],
      offline: true,
    });
    const handler = worker.listeners.activate?.[0];
    assert.ok(handler, "public/sw.js must register an activate handler");
    const waits: Promise<unknown>[] = [];
    handler({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);

    assert.deepEqual(
      worker.deletedUrls,
      [],
      "an asset we cannot prove is gone must be kept, not deleted",
    );
  });

  it("bumps CACHE_NAME so the previous shell cache is purged", () => {
    assert.match(swSource, /CACHE_NAME\s*=\s*"filament-shell-v3"/);
  });
});
