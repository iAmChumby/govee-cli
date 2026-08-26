/**
 * Named palette bank + the two palette-producing paths (WEBUI_V3_SPEC.md
 * §4.5, §4.6, §4.8):
 *
 *  - `paletteFromColor`/`paletteFromColorTempK` — a concrete device color
 *    (basic mode) becomes a single-stop palette for the `breathe` fallback,
 *    matching today's static-color rendering exactly.
 *  - `colorWordInName`/`paletteForColorWord` — layer 1.5 of the resolver:
 *    a literal color word anywhere in a scene/DIY name forces the palette
 *    regardless of which archetype layer 1/2/3/4 picked.
 *
 * Pure data + pure functions — no React, no canvas.
 */

import { kelvinToRgb, type Rgb } from "@/components/stage/color";
import type { MotionArchetype, Palette } from "./types";

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

function toHex(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

export function rgbToHex(rgb: Rgb | { r: number; g: number; b: number }): string {
  const [r, g, b] = "r" in rgb ? [rgb.r, rgb.g, rgb.b] : rgb;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Single-stop palette from a concrete RGB color — the `breathe` archetype's
 *  static-color fallback, byte-identical in spirit to today's solid render. */
export function paletteFromColor(rgb: { r: number; g: number; b: number }): Palette {
  return { colors: [rgbToHex(rgb)] };
}

export function paletteFromColorTempK(kelvin: number): Palette {
  return { colors: [rgbToHex(kelvinToRgb(kelvin))] };
}

/* ---------------------------------------------------------- named palettes */

/** §4.6's literal ground-truth case: the exact scene Finding #1 describes. */
export const SLEEP_BLOB_PALETTE: Palette = { colors: ["#2b2fb0", "#b0299a"] };

/** §4.6's "generic drift bank", reused for the gradient-drift hash bucket
 *  and the sunrise/fade keyword default. */
export const GENERIC_DRIFT_PALETTE: Palette = { colors: ["#ffb37a", "#ff7ab3", "#7a9dff"] };

/** §4.6's "generic ocean bank", reused for the wave hash bucket and the
 *  wave/ocean keyword default. */
export const GENERIC_OCEAN_PALETTE: Palette = { colors: ["#1e9dd8", "#0b3d91"] };

/** §4.6's "vivid multi-hue" bank, given explicitly for the Gaming row;
 *  reused as the general chase-archetype default. */
export const VIVID_CHASE_PALETTE: Palette = {
  colors: ["#ff003c", "#ff9500", "#fff700", "#00ff85", "#00c3ff", "#7a00ff"],
};

/** No ground-truth bank specified for these archetypes' defaults — picked to
 *  read unmistakably as their namesake (lava-orange blob, candle flicker,
 *  cool twinkling white, a hard-edged strobe flash, cold falling rain, and
 *  the existing warm-white idle breathe). */
export const GENERIC_LAVA_PALETTE: Palette = { colors: ["#ff4d1a", "#ffb703", "#c1121f"] };
export const FIRE_FLICKER_PALETTE: Palette = { colors: ["#ff6a00", "#ffcf4d", "#ff2d00"] };
export const SPARKLE_WHITE_PALETTE: Palette = { colors: ["#ffffff", "#cfe8ff"] };
export const STROBE_FLASH_PALETTE: Palette = { colors: ["#ffffff", "#ff003c", "#00c3ff"] };
export const RAIN_BLUE_PALETTE: Palette = { colors: ["#4fa3ff", "#0d2b52"] };
export const WARM_BREATHE_PALETTE: Palette = { colors: ["#ffb26b"] };

/**
 * The layer-4 fallback palette (classify.ts's `resolveByName`) for a name
 * with NO curated table match and NO keyword match — genuinely zero signal.
 *
 * The bug this replaced: that layer used to hand back one of the archetype
 * defaults above (e.g. `GENERIC_LAVA_PALETTE`), chosen purely by
 * `sum(charCode) % 4` on the name. "Aurora" summed to a bucket that picked
 * lava-orange — a name with no relation to lava at all — and rendered with
 * exactly the same visual confidence as a real curated match. A desaturated
 * neutral can't be mistaken for a confident guess: it reads as "the console
 * does not know", which is the truth for these names. Used by BOTH the 3D
 * stage (via `classify.ts`) and the scene/DIY library thumbnails (via
 * `panels/shared.tsx`'s `nameToGradient`), so an indeterminate name renders
 * the same "unknown" grey everywhere instead of a confident hue in one place
 * and a different confident hue in the other.
 */
export const INDETERMINATE_PALETTE: Palette = { colors: ["#8a8a8a", "#5a5a5a"] };

/** One reasonable default palette per archetype, used whenever the resolver
 *  reaches an archetype without a more specific named/color-word palette. */
export const DEFAULT_PALETTE_FOR_ARCHETYPE: Record<MotionArchetype, Palette> = {
  breathe: WARM_BREATHE_PALETTE,
  blob: GENERIC_LAVA_PALETTE,
  plasma: VIVID_CHASE_PALETTE,
  wave: GENERIC_OCEAN_PALETTE,
  chase: VIVID_CHASE_PALETTE,
  sparkle: SPARKLE_WHITE_PALETTE,
  flicker: FIRE_FLICKER_PALETTE,
  strobe: STROBE_FLASH_PALETTE,
  "gradient-drift": GENERIC_DRIFT_PALETTE,
  rain: RAIN_BLUE_PALETTE,
};

/* --------------------------------------------------- layer 1.5 color words */

/** §4.5 layer 1.5's 11 recognized color words, each a 2-stop bank. `purple`'s
 *  bank is the literal value given in §4.6's "make a calming, purple" row;
 *  the rest are picked to read as unmistakably that color. */
export const COLOR_WORD_PALETTES: Record<string, Palette> = {
  purple: { colors: ["#6a2fb0", "#9b4fd6"] },
  violet: { colors: ["#6a2fb0", "#9b4fd6"] },
  blue: { colors: ["#1e6fd8", "#0b3d91"] },
  red: { colors: ["#ff2d2d", "#8f0d0d"] },
  green: { colors: ["#22c55e", "#065f46"] },
  orange: { colors: ["#ff8a1e", "#c1440e"] },
  yellow: { colors: ["#ffd400", "#b58900"] },
  pink: { colors: ["#ff5fa8", "#b0296a"] },
  warm: { colors: ["#ffb26b", "#ff7a3d"] },
  cool: { colors: ["#7ec8ff", "#2a5db0"] },
  white: { colors: ["#ffffff", "#dbe9ff"] },
};

/** Normalize + tokenize a scene/DIY name the same way for every layer that
 *  needs word-level matching (layer 1.5 here, layer 2 in classify.ts). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function tokenizeName(name: string): string[] {
  return normalizeName(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * §4.5 layer 1.5: does the (normalized) name contain one of the 11 literal
 * color words, as a whole token (so "cooler" doesn't accidentally trip
 * "cool")? Returns the matched word, or null.
 */
export function colorWordInName(name: string): string | null {
  const tokens = tokenizeName(name);
  for (const word of Object.keys(COLOR_WORD_PALETTES)) {
    if (tokens.includes(word)) return word;
  }
  return null;
}

export function paletteForColorWord(word: string): Palette {
  return COLOR_WORD_PALETTES[word] ?? WARM_BREATHE_PALETTE;
}

/* The old `applyColorWordOverride(name, fallback)` wrapper lived here and
 * was left behind, exported and uncalled, when classify.ts moved to
 * `colorWordInName`/`paletteForColorWord` directly. It is deleted rather
 * than kept "just in case": a second, unused path applying layer 1.5 is
 * exactly how the stage and the library thumbnail drifted apart in the
 * first place — one caller gets updated, the forgotten one does not, and
 * the two disagree about the same scene again. Layer 1.5 has one call
 * site: `paletteForResolution` in classify.ts. */
