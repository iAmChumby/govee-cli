/**
 * Symmetry/mirror — a live modifier applied on top of brush strokes, not a
 * standalone tool of its own (§5.7: "Symmetry mirrors update live during
 * the drag"). Pure geometry + a diff-producing helper, unit-testable like
 * every other file in `tools/`.
 */

import type { CellDiff, Geometry, Rgb } from "../device-geometry";
import { ledIndex, rowColOf } from "../device-geometry";

export type SymmetryAxis = "none" | "col" | "row";

/** Reflects a cell across the canvas's vertical (`col`) or horizontal
 *  (`row`) midline. A cell that sits exactly on the axis (odd dimension,
 *  center column/row) maps to itself. */
export function mirrorCell(
  geometry: Geometry,
  row: number,
  col: number,
  axis: SymmetryAxis,
): { row: number; col: number } {
  if (axis === "col") return { row, col: geometry.cols - 1 - col };
  if (axis === "row") return { row: geometry.rows - 1 - row, col };
  return { row, col };
}

export function mirrorIndex(geometry: Geometry, index: number, axis: SymmetryAxis): number {
  if (axis === "none") return index;
  const { row, col } = rowColOf(geometry, index);
  const m = mirrorCell(geometry, row, col, axis);
  return ledIndex(geometry, m.row, m.col);
}

/**
 * Given the diffs a brush stroke just produced, returns the *additional*
 * diffs needed to mirror them — reading `from` off the live canvas so an
 * undo of the combined stroke restores both halves correctly. Cells that
 * mirror onto themselves (the axis line) or are already covered by the
 * input diffs are skipped, so a symmetric stroke never double-paints or
 * fights its own mirror.
 */
export function symmetryDiffs(
  canvas: Uint8ClampedArray,
  geometry: Geometry,
  diffs: readonly CellDiff[],
  axis: SymmetryAxis,
): CellDiff[] {
  if (axis === "none" || diffs.length === 0) return [];
  const covered = new Set(diffs.map((d) => d.index));
  const out: CellDiff[] = [];
  for (const d of diffs) {
    const mirrored = mirrorIndex(geometry, d.index, axis);
    if (mirrored === d.index || covered.has(mirrored)) continue;
    covered.add(mirrored);
    const o = mirrored * 3;
    const from: Rgb = [canvas[o], canvas[o + 1], canvas[o + 2]];
    if (from[0] === d.to[0] && from[1] === d.to[1] && from[2] === d.to[2]) continue;
    out.push({ index: mirrored, from, to: d.to });
  }
  return out;
}
