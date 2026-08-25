/**
 * Eyedropper — samples the canvas's current color at a cell. Backs both
 * the toolbar "eyedropper" tool and the long-press-anywhere gesture
 * (§5.7: "quick eyedropper-on-hold").
 */

import type { Geometry, Rgb } from "../device-geometry";
import { ledIndex } from "../device-geometry";

export function sampleColor(canvas: Uint8ClampedArray, geometry: Geometry, row: number, col: number): Rgb {
  const o = ledIndex(geometry, row, col) * 3;
  return [canvas[o], canvas[o + 1], canvas[o + 2]];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}
