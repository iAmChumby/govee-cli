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

/** Warm incandescent anchor — the color a filament glows before it settles. */
export const WARM_HSL: Hsl = [36, 92, 64];

/**
 * Emission color for a given brightness factor (0..1): deep colors stay
 * readable at low brightness but the whole surface visibly dims as the
 * device is turned down, so the render tracks the physical dial.
 */
export function emissionHsl(hsl: Hsl, factor: number): Hsl {
  const scaled = hsl[2] * (0.58 + 0.42 * clamp(factor, 0, 1));
  return withLightness(hsl, scaled);
}

/**
 * How far apart an RGB triple's channels may sit and still count as "the
 * firmware's white", in 0..255. Deliberately tight: the device palette ships
 * a genuine cool-white swatch at `#EAF2FF` (spread 21), and a person who
 * picks that has commanded a colour, not a placeholder. 8 covers firmware
 * rounding on a true white and nothing anyone chose on purpose.
 */
const PLACEHOLDER_WHITE_SPREAD = 8;

/**
 * True when a reported colour carries no hue worth believing.
 *
 * A device in colour-temperature mode reports `colorRgb` as a flat white
 * rather than as the amber it is actually emitting — the temperature is the
 * field carrying the information. Detecting that case is what lets the render
 * take the temperature instead.
 */
export function isPlaceholderWhite(rgb: Rgb): boolean {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  return max - min <= PLACEHOLDER_WHITE_SPREAD;
}

/**
 * True when the colour temperature is the honest reading of the pair.
 *
 * Shared by the renders and by the textual readouts so a card cannot print
 * `#FFFFFF` next to an instrument glowing 2000 K amber.
 */
export function prefersColorTemp(rgb: Rgb | null, colorTempK: number | null): boolean {
  if (colorTempK === null) return false;
  return rgb === null || isPlaceholderWhite(rgb);
}

/**
 * The one colour a device reported as plain colour/temperature is emitting.
 *
 * `colorRgb` and `colorTemperatureK` are mutually exclusive modes on the
 * hardware, but the cloud reports both fields on every read — a lamp sitting
 * at 2000 K comes back as `colorRgb` white *plus* `colorTemperatureK: 2000`.
 * Reading `color` first (as every call site here used to) throws the only
 * informative half away and paints a flat neutral slab while the room is
 * visibly amber. A saturated colour still outranks the temperature, because
 * there the RGB is the commanded value and the temperature is the leftover.
 *
 * Only valid for `basic`/`off`/`unknown` modes: while a scene, DIY or music
 * mode is running, both fields are stale and the motion engine's classified
 * palette is the answer instead.
 */
export function basicHsl(rgb: Rgb | null, colorTempK: number | null): Hsl {
  if (colorTempK !== null && prefersColorTemp(rgb, colorTempK)) {
    return rgbToHsl(kelvinToRgb(colorTempK));
  }
  if (rgb) return rgbToHsl(rgb);
  return WARM_HSL;
}
