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

interface CacheRequest {
  method: string;
  url: string;
}

/** Execute public/sw.js and take its shouldCache function. */
function loadShouldCache(): (request: CacheRequest) => boolean {
  const context: Record<string, unknown> = {
    location: { origin: ORIGIN },
    self: {
      addEventListener: () => undefined,
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    },
    caches: {
      open: async () => ({
        add: async () => undefined,
        put: async () => undefined,
      }),
      match: async () => undefined,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => undefined,
    URL,
    console,
  };
  vm.createContext(context);
  vm.runInContext(swSource, context, { filename: "public/sw.js" });
  const fn = context.shouldCache;
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

  it("bumps CACHE_NAME so the previous shell cache is purged", () => {
    assert.match(swSource, /CACHE_NAME\s*=\s*"filament-shell-v2"/);
  });
});
