/**
 * Pure color math for the stage renderer and paint controls.
 *
 * No React, no side effects — everything here is unit-testable. HSL is the
 * working space because the stage modulates *lightness by brightness* and
 * derives glows from the same hue/sat, which is awkward in raw RGB.
 */

export type Rgb = readonly [number, number, number];
export type Hsl = readonly [number, number, number]; // h ∈ 0..360, s/l ∈ 0..100

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * RGB (0..255 per channel) → HSL (h 0..360°, s/l 0..100%).
 * Standard HSL definition; returns [0, 0, l] for grays.
 */
export function rgbToHsl(rgb: Rgb): Hsl {
  const r = clamp(rgb[0], 0, 255) / 255;
  const g = clamp(rgb[1], 0, 255) / 255;
  const b = clamp(rgb[2], 0, 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, Math.round(l * 100)];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;

  return [h, Math.round(s * 100), Math.round(l * 100)];
}

/**
 * Color temperature → RGB, Tanner Helland's approximation (the one every
 * lighting tool ships). Inputs outside 1000–40000 K are clamped; Govee
 * specs (2000–9000 K) land well inside. Returns sRGB 0..255 per channel.
 */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = clamp(kelvin, 1000, 40000) / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return [
    clamp(Math.round(r), 0, 255),
    clamp(Math.round(g), 0, 255),
    clamp(Math.round(b), 0, 255),
  ];
}

/** Modern CSS color string: `hsl(H S% L%)`. */
export function hslCss(hsl: Hsl): string {
  return `hsl(${hsl[0]} ${hsl[1]}% ${hsl[2]}%)`;
}

/** Same, with explicit alpha (0..1): `hsl(H S% L% / A)`. */
export function hslaCss(hsl: Hsl, alpha: number): string {
  return `hsl(${hsl[0]} ${hsl[1]}% ${hsl[2]}% / ${clamp(alpha, 0, 1).toFixed(3)})`;
}

/** Lightness-shifted copy of an HSL, clamped to legal range. */
export function withLightness(hsl: Hsl, lightness: number): Hsl {
  return [hsl[0], hsl[1], clamp(Math.round(lightness), 0, 100)];
}
