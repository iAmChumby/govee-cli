import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #6 — Service Worker cache contract (CI gate).
 *
 * Extracts the real NEVER_CACHE_PATTERNS regexes from public/sw.js and
 * evaluates them against the forbidden routes, so a renamed pattern or a
 * typo in the path fails here instead of serving stale device state.
 */
describe("Service Worker cache contract (#6)", () => {
  const swSource = fs.readFileSync(
    path.resolve(process.cwd(), "public/sw.js"),
    "utf8",
  );

  /** The regex literals the SW actually ships, re-parsed from source. */
  const patterns: RegExp[] = [
    ...swSource.matchAll(/(\/\^[^\n]+?\/)(?=[,\s])/g),
  ].map((m) => new RegExp(m[1].slice(1, -1)));

  beforeAll(() => {
    // The extraction itself is load-bearing: if it finds nothing the
    // assertions below would pass vacuously.
    assert.ok(
      patterns.length >= 3,
      `expected to extract >=3 NEVER_CACHE_PATTERNS from sw.js, got ${patterns.length}`,
    );
  });

  describe("never caches device state", () => {
    const forbidden = [
      "/api/v1/devices",
      "/api/v1/devices/Shelf%20Lamp",
      "/api/v1/devices/Shelf%20Lamp/state",
      "/api/v1/devices/Light%20Bars/active-mode", // PUT ledger correction
      "/api/v1/effects",
      "/api/v1/effects/playing",
    ];

    for (const pathname of forbidden) {
      it(`blocks ${pathname}`, () => {
        const blocked = patterns.some((p) => p.test(pathname));
        assert.ok(blocked, `${pathname} must match a NEVER_CACHE_PATTERN`);
      });
    }
  });

  describe("still caches the shell", () => {
    const allowed = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

    for (const pathname of allowed) {
      it(`allows ${pathname}`, () => {
        const blocked = patterns.some((p) => p.test(pathname));
        assert.ok(!blocked, `${pathname} must not match any NEVER_CACHE_PATTERN`);
      });
    }
  });

  it("only caches GET requests (PUT active-mode can never be cached)", () => {
    assert.ok(
      /request\.method\s*!==\s*["']GET["']/.test(swSource),
      "shouldCache must reject non-GET methods before pattern checks",
    );
  });

  it("STATIC_ASSETS contains no forbidden route", () => {
    const m = swSource.match(/STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(m, "STATIC_ASSETS array not found");
    const entries = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    for (const entry of entries) {
      const blocked = patterns.some((p) => p.test(entry));
      assert.ok(
        !blocked,
        `STATIC_ASSETS entry ${entry} matches a NEVER_CACHE_PATTERN`,
      );
    }
  });
});
