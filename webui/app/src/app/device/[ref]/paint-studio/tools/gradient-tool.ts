/**
 * Gradient tool — a two-point linear gradient across the whole canvas,
 * projecting each cell onto the line between the two picked points and
 * interpolating gamma-correctly (the same sRGB EOTF `device-geometry.ts`'s
 * `downsampleFrame()` uses for segment averaging), so a painted gradient
 * and its downsampled hardware preview share one color model instead of
 * drifting apart into two different "muddy midpoint" curves.
 */

import type { CellDiff, Geometry, Rgb } from "../device-geometry";
import { ledIndex, linearToSrgb, srgbToLinear } from "../device-geometry";

export interface GradientPoint {
  row: number;
  col: number;
}

/** Gamma-correct lerp between two sRGB colors, `t` clamped to [0,1]. */
export function lerpColorGamma(a: Rgb, b: Rgb, t: number): Rgb {
  const c = Math.min(1, Math.max(0, t));
  const out = [0, 1, 2].map((i) =>
    linearToSrgb(srgbToLinear(a[i]) * (1 - c) + srgbToLinear(b[i]) * c),
  );
  return [out[0], out[1], out[2]];
}

/**
 * Every cell's color is set by projecting its (row, col) onto the line
 * `from → to` and interpolating `fromColor → toColor` along that
 * projection, clamped past either endpoint (a hard edge, not an
 * extrapolated overshoot). Cells whose resulting color already matches are
 * skipped, so re-applying an identical gradient produces an empty diff set.
 */
export function gradientFill(
  canvas: Uint8ClampedArray,
  geometry: Geometry,
  from: GradientPoint,
  to: GradientPoint,
  fromColor: Rgb,
  toColor: Rgb,
): CellDiff[] {
  const dx = to.col - from.col;
  const dy = to.row - from.row;
  const lenSq = dx * dx + dy * dy || 1;
  const diffs: CellDiff[] = [];

  for (let row = 0; row < geometry.rows; row += 1) {
    for (let col = 0; col < geometry.cols; col += 1) {
      const px = col - from.col;
      const py = row - from.row;
      const t = Math.min(1, Math.max(0, (px * dx + py * dy) / lenSq));
      const color = lerpColorGamma(fromColor, toColor, t);
      const index = ledIndex(geometry, row, col);
      const o = index * 3;
      const current: Rgb = [canvas[o], canvas[o + 1], canvas[o + 2]];
      if (current[0] === color[0] && current[1] === color[1] && current[2] === color[2]) continue;
      diffs.push({ index, from: current, to: color });
    }
  }

  return diffs;
}
