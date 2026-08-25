/**
 * Tests for `use-edge-scroll.ts` against WEBUI_V3_SPEC.md §11.6 T32 —
 * see that file's docblock. `computeEdges` is the pure half of the hook
 * and therefore the only half a node-environment vitest run (no jsdom,
 * per `vitest.config.ts`) can exercise directly.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { computeEdges } from "./use-edge-scroll";

test("a row that fits exactly is not scrollable, and reports both edges", () => {
  const edges = computeEdges(0, 316, 316);
  assert.equal(edges.scrollable, false);
  assert.equal(edges.atStart, true);
  assert.equal(edges.atEnd, true);
});

test("a sub-pixel scrollWidth residual is not treated as scrollable", () => {
  // Browsers routinely report a fractional overflow (e.g. 316 vs 315.6)
  // on a row with nothing to actually scroll to. Below the 2px threshold
  // this must read as "fits", or the fade flickers permanently on.
  const edges = computeEdges(0, 317.5, 316);
  assert.equal(edges.scrollable, false);
  assert.equal(edges.atStart, true);
  assert.equal(edges.atEnd, true);
});

test("scrolled to the start: start edge hidden, end edge shown", () => {
  const edges = computeEdges(0, 460, 316);
  assert.equal(edges.scrollable, true);
  assert.equal(edges.atStart, true);
  assert.equal(edges.atEnd, false);
});

test("mid-scroll: both edges have more content, both affordances show", () => {
  const edges = computeEdges(72, 460, 316);
  assert.equal(edges.scrollable, true);
  assert.equal(edges.atStart, false);
  assert.equal(edges.atEnd, false);
});

test("scrolled to the end: end edge hidden, start edge shown", () => {
  const overflow = 460 - 316;
  const edges = computeEdges(overflow, 460, 316);
  assert.equal(edges.scrollable, true);
  assert.equal(edges.atStart, false);
  assert.equal(edges.atEnd, true);
});

test("a sub-pixel residual against either end still counts as that edge", () => {
  // scrollLeft lands 0.5px short of the true overflow due to rounding
  // during a real scroll event — this must not strand the affordance on
  // by a fraction of a pixel.
  const overflow = 460 - 316;
  const nearEnd = computeEdges(overflow - 0.5, 460, 316);
  assert.equal(nearEnd.atEnd, true);

  const nearStart = computeEdges(0.5, 460, 316);
  assert.equal(nearStart.atStart, true);
});
