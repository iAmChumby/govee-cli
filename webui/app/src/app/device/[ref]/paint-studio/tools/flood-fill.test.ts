import assert from "node:assert/strict";
import { test } from "vitest";

import { floodFill } from "./flood-fill";

test("floodFill: fills every connected cell of the target color", () => {
  const geometry = { rows: 3, cols: 4, wrapCol: true };
  const canvas = new Uint8ClampedArray(3 * 4 * 3); // all black
  const diffs = floodFill(canvas, geometry, 0, [9, 9, 9]);
  assert.equal(diffs.length, 12); // the whole grid is one connected black region
  assert.ok(diffs.every((d) => d.to[0] === 9 && d.to[1] === 9 && d.to[2] === 9));
});

test("floodFill: a no-op fill (target already matches) produces zero diffs", () => {
  const geometry = { rows: 3, cols: 4, wrapCol: true };
  const canvas = new Uint8ClampedArray(3 * 4 * 3);
  assert.equal(floodFill(canvas, geometry, 0, [0, 0, 0]).length, 0);
});

test("floodFill: respects the column-wrap boundary (H6022's drum)", () => {
  // 3x4 wrapped grid; column 0 is painted a distinct color so it forms an
  // island boundary. Filling from (row 1, col 2) should reach columns
  // 1, 2, 3 across all 3 rows (9 cells) by wrapping col3 -> col0's
  // *neighbor* check (col0 itself is excluded, being a different color) —
  // proving the fill actually crosses the col3/col0 seam rather than
  // stopping dead at the array edge.
  const geometry = { rows: 3, cols: 4, wrapCol: true };
  const canvas = new Uint8ClampedArray(3 * 4 * 3);
  for (let row = 0; row < 3; row++) canvas[(row * 4 + 0) * 3] = 5;

  const diffs = floodFill(canvas, geometry, 1 * 4 + 2, [9, 9, 9]);
  assert.equal(diffs.length, 9);
  const touched = new Set(diffs.map((d) => d.index));
  assert.ok(!touched.has(0) && !touched.has(4) && !touched.has(8)); // col 0 never touched
});

test("floodFill: does not wrap rows even when columns wrap", () => {
  const geometry = { rows: 2, cols: 2, wrapCol: true };
  const canvas = new Uint8ClampedArray(2 * 2 * 3);
  // isolate (0,0)/(0,1) from (1,0)/(1,1) with a distinct row-1 color
  canvas[(1 * 2 + 0) * 3] = 5;
  canvas[(1 * 2 + 1) * 3] = 5;
  const diffs = floodFill(canvas, geometry, 0, [9, 9, 9]);
  assert.equal(diffs.length, 2); // only row 0's two cells, never spills into row 1
});
