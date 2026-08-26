/**
 * The one colour a device's chrome should bleed, given what it is actually doing.
 *
 * The card's ambient tint used to come straight off `color` / `color_temp_k`,
 * which is exactly the stale reading the ledger exists to correct. A lamp
 * running the "sleep" DIY scene reports colorTemperatureK 2700 forever, so the
 * card bled warm amber while the instrument inside it rendered the scene's real
 * blue-to-magenta blobs — the same "the GUI does not match the room" mismatch,
 * reproduced one element out.
 *
 * When a motion mode is playing, the palette the motion engine is drawing with
 * IS the honest answer, so average its stops. When nothing is playing, fall
 * back to the cloud reading, which is trustworthy for plain colour/temp.
 */

import { basicHsl, rgbToHsl, type Hsl } from "@/components/stage/color";

import { classifyActiveMode } from "./classify";
import type { ActiveMode as MotionActiveMode, Palette } from "./types";

/** "#rrggbb" (or "#rgb") -> rgb triple; null for anything unparseable. */
function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Mean of a palette's stops in RGB, as HSL. */
export function paletteHsl(palette: Palette): Hsl | null {
  const stops = palette.colors
    .map((hex) => hexToRgb(hex))
    .filter((rgb): rgb is [number, number, number] => rgb !== null);
  if (stops.length === 0) return null;

  // Averaging in RGB rather than in hue space is deliberate: two stops 180
  // degrees apart average to a neutral, which is the right answer for an
  // ambient wash. Circular-mean hue would instead pick an arbitrary side and
  // read as a confident colour the scene never shows.
  const sum = stops.reduce<[number, number, number]>(
    (acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b],
    [0, 0, 0],
  );
  const n = stops.length;
  return rgbToHsl([
    Math.round(sum[0] / n),
    Math.round(sum[1] / n),
    Math.round(sum[2] / n),
  ]);
}

export interface DominantHslInput {
  color: { rgb: [number, number, number] } | null;
  colorTempK: number | null;
  /** null when no motion mode is playing (off / basic / unknown). */
  motionMode: MotionActiveMode | null;
  model: string;
}

export function dominantHsl({
  color,
  colorTempK,
  motionMode,
  model,
}: DominantHslInput): Hsl {
  if (motionMode) {
    const fromPalette = paletteHsl(classifyActiveMode(motionMode, model).palette);
    if (fromPalette) return fromPalette;
  }
  return basicHsl(color?.rgb ?? null, colorTempK);
}
