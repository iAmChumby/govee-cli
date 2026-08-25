import assert from "node:assert/strict";
import { test } from "vitest";

import { mirrorCell, mirrorIndex, symmetryDiffs } from "./symmetry";

const geometry = { rows: 2, cols: 4, wrapCol: false };

test("mirrorCell: col axis reflects left-right", () => {
  assert.deepEqual(mirrorCell(geometry, 0, 0, "col"), { row: 0, col: 3 });
  assert.deepEqual(mirrorCell(geometry, 1, 3, "col"), { row: 1, col: 0 });
});

test("mirrorCell: row axis reflects top-bottom", () => {
  assert.deepEqual(mirrorCell(geometry, 0, 1, "row"), { row: 1, col: 1 });
});

test("mirrorCell: 'none' is the identity", () => {
  assert.deepEqual(mirrorCell(geometry, 1, 2, "none"), { row: 1, col: 2 });
});

test("mirrorIndex: matches mirrorCell composed with ledIndex", () => {
  assert.equal(mirrorIndex(geometry, 0, "col"), 3); // (0,0) -> (0,3)
  assert.equal(mirrorIndex(geometry, 1, "row"), 5); // (0,1) -> (1,1) = index 5
});

test("symmetryDiffs: mirrors one brush diff onto its symmetric cell", () => {
  const canvas = new Uint8ClampedArray(2 * 4 * 3);
  const diffs = symmetryDiffs(canvas, geometry, [{ index: 0, from: [0, 0, 0], to: [255, 0, 0] }], "col");
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].index, 3);
  assert.deepEqual(diffs[0].to, [255, 0, 0]);
});

test("symmetryDiffs: a cell sitting on the axis never mirrors onto itself", () => {
  const oddGeometry = { rows: 1, cols: 3, wrapCol: false }; // center col 1 is its own mirror
  const canvas = new Uint8ClampedArray(1 * 3 * 3);
  const diffs = symmetryDiffs(canvas, oddGeometry, [{ index: 1, from: [0, 0, 0], to: [255, 0, 0] }], "col");
  assert.equal(diffs.length, 0);
});

test("symmetryDiffs: skips a mirror cell already covered by the input diffs", () => {
  const canvas = new Uint8ClampedArray(2 * 4 * 3);
  const both = [
    { index: 0, from: [0, 0, 0] as const, to: [255, 0, 0] as const },
    { index: 3, from: [0, 0, 0] as const, to: [0, 0, 255] as const },
  ];
  // both halves of the stroke already painted by the caller — nothing left to mirror
  assert.equal(symmetryDiffs(canvas, geometry, both, "col").length, 0);
});

test("symmetryDiffs: 'none' produces no diffs at all", () => {
  const canvas = new Uint8ClampedArray(2 * 4 * 3);
  assert.equal(symmetryDiffs(canvas, geometry, [{ index: 0, from: [0, 0, 0], to: [255, 0, 0] }], "none").length, 0);
});
