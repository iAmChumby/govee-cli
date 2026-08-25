/**
 * Tests for `geometry.ts`'s per-model adapter and the pure region-math
 * helpers `regionRectPx`/`clipToRegion` (WEBUI_V3_SPEC.md §4.2, §4.8).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { buildGeometry, regionRectPx } from "./geometry";

test("H6056 resolves to 2 bar regions", () => {
  const g = buildGeometry("H6056");
  assert.equal(g.kind, "bars");
  assert.equal(g.regions.length, 2);
});

test("H6022 resolves to 1 matrix region", () => {
  const g = buildGeometry("H6022");
  assert.equal(g.kind, "matrix");
  assert.equal(g.regions.length, 1);
});

test("an unknown/other model (e.g. H6008) resolves to 1 orb region", () => {
  const g = buildGeometry("H6008");
  assert.equal(g.kind, "orb");
  assert.equal(g.regions.length, 1);
});

test("a null model falls back to the orb geometry rather than crashing", () => {
  const g = buildGeometry(null);
  assert.equal(g.kind, "orb");
});

test("regionRectPx scales normalized bounds by the given pixel dimensions", () => {
  const rect = regionRectPx({ bounds: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } }, 400, 200);
  assert.deepEqual(rect, { x: 100, y: 100, w: 200, h: 50 });
});
