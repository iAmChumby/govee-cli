/**
 * Pure, framework-free geometry + color math for the Matrix Paint Studio
 * (WEBUI_V3_SPEC.md §5). No React, no DOM, no fetch — every export here is
 * unit-testable the same way `components/stage/color.ts`'s `rgbToHsl`/
 * `kelvinToRgb` are: known input in, hand-computable output out.
 *
 * The canvas itself lives outside this module (in `use-paint-canvas.ts`) as
 * a `Uint8ClampedArray` of length `rows * cols * 3`, addressed by
 * `ledIndex()`. Every function here operates on that same flat array so the
 * canvas, the two live previews, and the effect exporter all agree on one
 * indexing scheme.
 */

export type Rgb = readonly [number, number, number];

/** Per-model matrix shape — mirrors `Capabilities.matrix_rows/cols/wrap_col`
 *  (`lib/api.ts`, T10) 1:1. `wrapCol=true` means column `cols-1` is
 *  physically adjacent to column `0` (the H6022's drum). */
export interface Geometry {
  rows: number;
  cols: number;
  wrapCol: boolean;
}

export function totalLeds(geometry: Geometry): number {
  return geometry.rows * geometry.cols;
}

/** `led(row, col) = row * cols + col` — the confirmed H6022 formula
 *  (CLAUDE.md), generalized to any rows×cols geometry. */
export function ledIndex(geometry: Geometry, row: number, col: number): number {
  return row * geometry.cols + col;
}

export function rowColOf(geometry: Geometry, index: number): { row: number; col: number } {
  return { row: Math.floor(index / geometry.cols), col: index % geometry.cols };
}

/** Column wraps modulo `cols` when `wrapCol`; otherwise clamps to range.
 *  Rows never wrap — no model in this fleet wraps top-to-bottom. */
export function normalizeCol(geometry: Geometry, col: number): number {
  if (geometry.wrapCol) return ((col % geometry.cols) + geometry.cols) % geometry.cols;
  return Math.min(geometry.cols - 1, Math.max(0, col));
}

export function normalizeRow(geometry: Geometry, row: number): number {
  return Math.min(geometry.rows - 1, Math.max(0, row));
}

/** The unit of both undo/redo and the live-preview throttle (§5.1). */
export interface CellDiff {
  index: number;
  from: Rgb;
  to: Rgb;
}

/* ------------------------------------------------------- §5.2 downsample */

/** Contiguous, equal(ish) runs along raster LED order — the default
 *  hypothesis used until a device is calibrated (§5.2/§5.3), verbatim from
 *  the spec's pseudocode. `boundaries[i]..boundaries[i+1]` is segment `i`'s
 *  LED range; `boundaries.length === segmentCount + 1`. */
export function defaultBoundaries(totalLedCount: number, segmentCount: number): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i <= segmentCount; i += 1) {
    boundaries.push(Math.floor((i * totalLedCount) / segmentCount));
  }
  return boundaries;
}

/** The subset of `SegmentCalibration` (`lib/api.ts`, T10) this module
 *  needs — kept local so it has no dependency on the API client shape. */
export interface CalibrationLike {
  boundaries: number[] | null;
  permutation: number[] | null;
}

/** §5.3 — calibration substitutes the default hypothesis when a saved,
 *  correctly-shaped calibration exists; otherwise the honest guess. */
export function segmentBoundaries(
  totalLedCount: number,
  segmentCount: number,
  calibration?: CalibrationLike | null,
): number[] {
  if (calibration?.boundaries && calibration.boundaries.length === segmentCount + 1) {
    return calibration.boundaries;
  }
  return defaultBoundaries(totalLedCount, segmentCount);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** sRGB (0..255) → linear light (0..1). Standard EOTF: linear toe below
 *  0.04045, power curve above — the same curve every color-managed
 *  compositor uses, not a naive `pow(c, 2.2)` shortcut. */
export function srgbToLinear(channel255: number): number {
  const v = clamp01(channel255 / 255);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light (0..1) → sRGB (0..255), inverse EOTF, rounded to a byte. */
export function linearToSrgb(linear: number): number {
  const v = clamp01(linear);
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(clamp01(c) * 255);
}

/**
 * §5.2's acceptance-definition pseudocode, verbatim: average each segment's
 * covered LEDs in *linear* light, then convert back — avoids the "muddy
 * midpoint" naive sRGB averaging produces (already flagged by the
 * effects-engine review of the existing linear-RGB interpolation). Reused
 * unchanged for both the static hardware-preview quantization and every
 * generated motion frame at export time (§5.4).
 */
export function downsampleFrame(canvas: Uint8ClampedArray, boundaries: number[]): Rgb[] {
  const segments: Rgb[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    const count = Math.max(1, hi - lo);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let led = lo; led < hi; led += 1) {
      const o = led * 3;
      sumR += srgbToLinear(canvas[o]);
      sumG += srgbToLinear(canvas[o + 1]);
      sumB += srgbToLinear(canvas[o + 2]);
    }
    segments.push([
      linearToSrgb(sumR / count),
      linearToSrgb(sumG / count),
      linearToSrgb(sumB / count),
    ]);
  }
  return segments;
}

/**
 * §5.3: calibration's *permutation* half. `downsampleFrame()` returns
 * colors in raster boundary order (boundary-group `i`); the calibration
 * wizard records which physical segment id actually lit up for each
 * boundary-group (`permutation[i]`). This reindexes accordingly — applied
 * as a step *after* `downsampleFrame()`, never inside it, so the averaging
 * logic itself never has to know calibration exists (matches §5.2's "the
 * averaging logic itself is unchanged, only which LED indices belong to
 * which segment changes"). A missing/mismatched permutation is the
 * identity mapping — the honest default before calibration.
 */
export function applySegmentPermutation(colors: Rgb[], permutation: number[] | null): Rgb[] {
  if (!permutation || permutation.length !== colors.length) return colors;
  const out: Rgb[] = new Array(colors.length);
  for (let i = 0; i < colors.length; i += 1) out[permutation[i]] = colors[i];
  return out;
}

/* --------------------------------------------------------------- §5.4 motion */

export type MotionAxis = "col" | "row";

export type Motion =
  | { type: "static" }
  | { type: "scroll" | "rotate" | "pingpong"; axis: MotionAxis; sign: 1 | -1; periodSeconds: number }
  | { type: "pulse"; periodSeconds: number };

/** `frameCount = round(periodSeconds * exportFps)` (§5.4, verbatim) — a
 *  static canvas is always exactly one frame. */
export function frameCountFor(motion: Motion, exportFps: number): number {
  if (motion.type === "static") return 1;
  return Math.max(1, Math.round(motion.periodSeconds * exportFps));
}

/** Triangle wave over one period: 0 → 1 → 0, for `pingpong`'s bounce. */
function triangleWave(t: number): number {
  const x = ((t % 1) + 1) % 1;
  return x < 0.5 ? x * 2 : 2 - x * 2;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * One motion-descriptor frame: the painted canvas shifted (or, for
 * `pulse`, globally dimmed) per §5.4. Pull-sampled — every destination
 * cell reads its source cell rather than pushing values forward — so wrap
 * and clamp both fall out of one `normalizeCol`/`normalizeRow` call with
 * no gaps or double-writes. `static` returns an unshifted copy so callers
 * can always treat frame 0 uniformly regardless of motion type.
 */
export function applyMotion(
  canvas: Uint8ClampedArray,
  geometry: Geometry,
  motion: Motion,
  frameIndex: number,
  exportFps: number,
): Uint8ClampedArray {
  if (motion.type === "static") return canvas.slice() as Uint8ClampedArray;

  const frames = frameCountFor(motion, exportFps);

  if (motion.type === "pulse") {
    const t = frames > 0 ? frameIndex / frames : 0;
    // Never fully dark — a "pulse" reads as breathing, not blinking.
    const factor = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t));
    const out = new Uint8ClampedArray(canvas.length);
    for (let i = 0; i < canvas.length; i += 1) out[i] = Math.round(canvas[i] * factor);
    return out;
  }

  const dim = motion.axis === "col" ? geometry.cols : geometry.rows;
  const wrap = motion.axis === "col" ? geometry.wrapCol : false;

  let shift: number;
  if (motion.type === "pingpong") {
    shift = Math.round(triangleWave(frameIndex / Math.max(1, frames)) * dim) * motion.sign;
  } else {
    shift = Math.round((frameIndex * dim) / Math.max(1, frames)) * motion.sign;
  }

  const out = new Uint8ClampedArray(canvas.length);
  for (let row = 0; row < geometry.rows; row += 1) {
    for (let col = 0; col < geometry.cols; col += 1) {
      let srcRow = row;
      let srcCol = col;
      if (motion.axis === "col") {
        const raw = col - shift;
        srcCol = wrap ? ((raw % dim) + dim) % dim : clampInt(raw, 0, dim - 1);
      } else {
        const raw = row - shift;
        srcRow = wrap ? ((raw % dim) + dim) % dim : clampInt(raw, 0, dim - 1);
      }
      const srcO = ledIndex(geometry, srcRow, srcCol) * 3;
      const dstO = ledIndex(geometry, row, col) * 3;
      out[dstO] = canvas[srcO];
      out[dstO + 1] = canvas[srcO + 1];
      out[dstO + 2] = canvas[srcO + 2];
    }
  }
  return out;
}

/* ---------------------------------------------------- §5.6 effect emission */

function toHex(rgb: Rgb): string {
  return rgb
    .map((c) => Math.round(clamp01(c / 255) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export interface EmittedKeyframe {
  t: number;
  color: string;
}

export interface EmittedSegment {
  id: number;
  keyframes: EmittedKeyframe[];
}

/**
 * §5.6: "emits one keyframe per segment only when that segment's color
 * changes from its previously emitted keyframe" — the emit-time mirror of
 * `webui/api/playback.py`'s `_play_cloud_blocking` runtime diffing. Input
 * is `framesBySegmentId[frameIndex][segmentId]` — already downsampled and,
 * if calibrated, permuted — so this function only ever dedups, never
 * re-derives color. Always emits a `t:0` keyframe for every segment (even
 * a fully static canvas needs one keyframe per segment to paint anything).
 */
export function buildEffectSegments(
  framesBySegmentId: Rgb[][],
  frameDurationMs: number,
): EmittedSegment[] {
  const segmentCount = framesBySegmentId[0]?.length ?? 0;
  const out: EmittedSegment[] = [];
  for (let seg = 0; seg < segmentCount; seg += 1) {
    const keyframes: EmittedKeyframe[] = [];
    let last: string | null = null;
    for (let f = 0; f < framesBySegmentId.length; f += 1) {
      const hex = toHex(framesBySegmentId[f][seg]);
      if (hex !== last) {
        keyframes.push({ t: Math.round(f * frameDurationMs), color: hex });
        last = hex;
      }
    }
    out.push({ id: seg, keyframes });
  }
  return out;
}
