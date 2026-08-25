/**
 * Flood fill — classic 4-neighbor fill, wrap-aware on the column axis
 * (the H6022's drum: column `cols-1` is adjacent to column `0`). Rows
 * never wrap. Exact color match, no tolerance: at 132 LEDs a near-match
 * dither is visually indistinguishable from a hard edge anyway, and exact
 * match keeps the algorithm — and its expected output — trivial to
 * hand-verify.
 */

import type { CellDiff, Geometry, Rgb } from "../device-geometry";
import { ledIndex, rowColOf } from "../device-geometry";

function colorAt(canvas: Uint8ClampedArray, index: number): Rgb {
  const o = index * 3;
  return [canvas[o], canvas[o + 1], canvas[o + 2]];
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function neighbors(geometry: Geometry, index: number): number[] {
  const { row, col } = rowColOf(geometry, index);
  const out: number[] = [];
  if (row > 0) out.push(ledIndex(geometry, row - 1, col));
  if (row < geometry.rows - 1) out.push(ledIndex(geometry, row + 1, col));
  const left = col > 0 ? col - 1 : geometry.wrapCol ? geometry.cols - 1 : -1;
  if (left >= 0) out.push(ledIndex(geometry, row, left));
  const right = col < geometry.cols - 1 ? col + 1 : geometry.wrapCol ? 0 : -1;
  if (right >= 0) out.push(ledIndex(geometry, row, right));
  return out;
}

/** Fills the connected region of `startIndex`'s color with `to`, returning
 *  the diffs (never mutates `canvas`). An empty array means the target
 *  cell already holds `to` — a no-op fill produces a no-op diff set, so
 *  callers never push an empty undo entry. */
export function floodFill(
  canvas: Uint8ClampedArray,
  geometry: Geometry,
  startIndex: number,
  to: Rgb,
): CellDiff[] {
  const target = colorAt(canvas, startIndex);
  if (sameColor(target, to)) return [];

  const visited = new Set<number>([startIndex]);
  const stack = [startIndex];
  const diffs: CellDiff[] = [];

  while (stack.length > 0) {
    const idx = stack.pop() as number;
    diffs.push({ index: idx, from: colorAt(canvas, idx), to });
    for (const n of neighbors(geometry, idx)) {
      if (visited.has(n)) continue;
      visited.add(n);
      if (sameColor(colorAt(canvas, n), target)) stack.push(n);
    }
  }

  return diffs;
}
