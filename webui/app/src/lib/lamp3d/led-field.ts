/**
 * The stage's "load-bearing seam" (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`):
 * `(MotionSpec, LedLayout, t) -> Uint8ClampedArray`. Every archetype that used
 * to fill a 2D Canvas region in `motion-engine/canvas-renderer.ts` is ported
 * here to evaluate a colour per LED instead — the port's central
 * simplification, because driving emitters is what the hardware actually
 * does, and a 2D "region" has no meaning once the device is a 3D model.
 *
 * PURE AND GL-FREE. No three.js import (not even type-only — `LedLayout`
 * comes from `models/types.ts`, which erases its own three.js import at
 * compile time), no DOM, no `Math.random()` anywhere the same `t` must
 * reproduce the same frame. That is what keeps this file runnable in the
 * plain Node vitest environment and testable with golden arrays.
 *
 * NO PER-LED ALLOCATION. `out` is owned by the caller (one `Uint8ClampedArray`
 * per mounted device, reused every frame) and this module never returns a new
 * array, pushes to one, or builds an object literal inside the loop that walks
 * LEDs. The one exception — deliberate, and confined to *outside* that loop —
 * is `getParsedPalette`'s memo: a `Palette`'s hex strings are parsed to numeric
 * RGB once per distinct palette and cached by a string key for the life of the
 * module, so a steady-state caller (the common case: the same handful of
 * palettes cycling every frame) allocates nothing at all after warmup.
 *
 * GEOMETRY. Every LED has (row, col) on a `rows x cols` matrix. Positions
 * normalise to:
 *
 *   u = cols > 1 ? col / (cols - 1) : 0
 *   v = rows > 1 ? row / (rows - 1) : 0
 *
 * When `layout.wrapCol` is true (the H6022 drum: column 11 physically touches
 * column 0), any archetype that measures a *distance* in u must use the
 * toroidal metric `min(|a-b|, 1-|a-b|)` rather than plain `|a-b|` — otherwise
 * column 0 and column 11 read as opposite ends of a strip instead of
 * neighbours on a cylinder, and a chase snaps at the seam instead of running
 * through it.
 *
 * DOMINANT AXIS. Two rules, chosen for two different reasons and kept
 * separate rather than folded into one "pick an axis" helper:
 *
 *  - `chase` always travels along u. In the original canvas version it moved
 *    along `rect.w` (horizontal) unconditionally; u is also the only axis
 *    that ever wraps, and a travelling dot is exactly the shape that needs to
 *    run continuously around the H6022's circumference. Tying chase to u
 *    unconditionally means the wrap behaviour above is never optional.
 *  - `wave` and `rain` default to v (rows) — this matches the original
 *    canvas version's vertical bands / falling streaks — but fall back to u
 *    when `layout.rows < 3`. Below that the row axis cannot carry a gradient
 *    or a falling streak without degenerating into a flat two-tone (the
 *    H6056's 2-row bars, per the spec's explicit requirement); u still has
 *    48 columns to work with there.
 *
 * `blob`/`plasma`/`sparkle`/`flicker` are inherently 2D (or global) in the
 * canvas version and stay that way here: they read both u and v (or neither),
 * so no axis choice applies to them.
 *
 * EFFECT PLAYBACK. `writeEffectFrame` reuses `effect-playback.ts`'s `frameAt`
 * exactly as the canvas path did, then spreads its per-segment colours across
 * the matrix's COLUMNS — every row in a column takes that segment's colour.
 * This is a template mapping, the same one `motion-engine/geometry.ts` used
 * for the flat stage: the cloud's segment rail is a linear interpolation
 * template over the physical matrix, not real per-cell addressing, and the
 * firmware's own interpolation rule is undocumented (`CLAUDE.md`, H6022
 * section). Do not read a column-spread frame as "this is how the lamp really
 * lights those LEDs" — it is the best rendering of the only data the cloud
 * gives back.
 *
 * NO BRIGHTNESS SCALING. Device brightness is `emission.ts`'s job
 * (`emissiveIntensity`, the same `brightnessGlow` curve the old stage used).
 * This module only ever outputs the *archetype's own* intensity math — the
 * same alpha/jitter/on-off modulation the canvas version blended onto a black
 * backing — because those modulations are the archetype's character, not the
 * user's brightness dial.
 */

import type { EffectDescriptor, MotionArchetype, MotionSpec, Palette } from "@/lib/motion-engine/types";
import { frameAt } from "@/lib/motion-engine/effect-playback";
import type { LedLayout } from "./models/types";
import { ledIndex } from "./models/types";

/* --------------------------------------------------------------- utilities */

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/** Toroidal-aware distance between two normalized (0..1) axis positions. */
function axisDistance(a: number, b: number, wrap: boolean): number {
  const d = Math.abs(a - b);
  return wrap ? Math.min(d, 1 - d) : d;
}

/** Cheap smooth "wander" in roughly [-1, 1] — identical to
 *  `canvas-renderer.ts`'s approximation of slow 2D value-noise, kept verbatim
 *  so blob/plasma keep the same drift character. */
function wander(phase: number, seed: number): number {
  return 0.6 * Math.sin(phase + seed) + 0.4 * Math.sin(phase * 0.37 + seed * 1.7 + 1.3);
}

function hexToRgbTriplet(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/* ------------------------------------------------------- palette memoizer */

/** A `Palette`'s hex stops, parsed once into parallel numeric arrays. Kept
 *  keyed by the joined colour string (not object identity) because
 *  `classify.ts`/`palette.ts` build a fresh `Palette` object on every call —
 *  identity would miss on every frame and defeat the memo entirely, while the
 *  actual colour list is what determines the parsed result. */
interface ParsedPalette {
  r: number[];
  g: number[];
  b: number[];
}

const paletteCache = new Map<string, ParsedPalette>();

function getParsedPalette(palette: Palette): ParsedPalette {
  const key = palette.colors.length > 0 ? palette.colors.join(",") : "#ffffff";
  const cached = paletteCache.get(key);
  if (cached) return cached;

  const colors = palette.colors.length > 0 ? palette.colors : ["#ffffff"];
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (const hex of colors) {
    const [rr, gg, bb] = hexToRgbTriplet(hex);
    r.push(rr);
    g.push(gg);
    b.push(bb);
  }
  const parsed: ParsedPalette = { r, g, b };
  paletteCache.set(key, parsed);
  return parsed;
}

/** Module-level scratch — every sampling function below writes its result
 *  here instead of returning a fresh `[r, g, b]` tuple, so sampling a colour
 *  inside the per-LED loop allocates nothing. Single-threaded JS makes this
 *  safe: nothing re-enters `evaluateLedField` while a call is in flight. */
const scratch = { r: 0, g: 0, b: 0 };

/** Cyclic interpolation across a palette's stops at `t` (wraps mod 1) —
 *  matches `canvas-renderer.ts`'s `interpolatePaletteColor` exactly, since
 *  every archetype that used it (blob, plasma, wave, chase, rain, sparkle,
 *  flicker) depends on that exact wrap-around cadence for its colour cycle. */
function sampleCyclic(parsed: ParsedPalette, t: number): void {
  const n = parsed.r.length;
  if (n === 1) {
    scratch.r = parsed.r[0]!;
    scratch.g = parsed.g[0]!;
    scratch.b = parsed.b[0]!;
    return;
  }
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * n;
  const i0 = Math.floor(scaled) % n;
  const i1 = (i0 + 1) % n;
  const f = scaled - Math.floor(scaled);
  scratch.r = parsed.r[i0]! + (parsed.r[i1]! - parsed.r[i0]!) * f;
  scratch.g = parsed.g[i0]! + (parsed.g[i1]! - parsed.g[i0]!) * f;
  scratch.b = parsed.b[i0]! + (parsed.b[i1]! - parsed.b[i0]!) * f;
}

/** Non-cyclic interpolation across a palette's stops at `s` (clamped 0..1) —
 *  matches `canvas-renderer.ts`'s `createLinearGradient` stop placement for
 *  `gradient-drift`, which does not wrap past its two named endpoints. */
function sampleClamped(parsed: ParsedPalette, s: number): void {
  const n = parsed.r.length;
  if (n === 1) {
    scratch.r = parsed.r[0]!;
    scratch.g = parsed.g[0]!;
    scratch.b = parsed.b[0]!;
    return;
  }
  const clamped = clamp01(s);
  const scaled = clamped * (n - 1);
  const i0 = Math.min(n - 2, Math.floor(scaled));
  const i1 = i0 + 1;
  const f = scaled - i0;
  scratch.r = parsed.r[i0]! + (parsed.r[i1]! - parsed.r[i0]!) * f;
  scratch.g = parsed.g[i0]! + (parsed.g[i1]! - parsed.g[i0]!) * f;
  scratch.b = parsed.b[i0]! + (parsed.b[i1]! - parsed.b[i0]!) * f;
}

/** Writes `scratch` scaled by `alpha` (the archetype's own intensity/jitter
 *  modulation, blended toward black — the LED-field equivalent of the canvas
 *  version's "draw at this alpha over a black backing") into `out` at
 *  `offset`. `Uint8ClampedArray` rounds and clamps on assignment, so no
 *  separate `Math.round`/clamp is needed here. */
function writeScaled(out: Uint8ClampedArray, offset: number, alpha: number): void {
  out[offset] = scratch.r * alpha;
  out[offset + 1] = scratch.g * alpha;
  out[offset + 2] = scratch.b * alpha;
}

/** Screen-blends `scratch * alpha` onto whatever is already at `offset`,
 *  reading the current (already-clamped) 0..255 values back as the running
 *  accumulator. Used by `blob`/`plasma`, which composite several soft lobes
 *  per LED with `globalCompositeOperation = "screen"` in the canvas version —
 *  confirmed algebraically identical to that per-pixel formula,
 *  `1 - (1 - cb)(1 - a*cs)`. `chase` does NOT use this; see `overBlend`. */
function screenBlend(out: Uint8ClampedArray, offset: number, alpha: number): void {
  const ar = clamp01(alpha) * (scratch.r / 255);
  const ag = clamp01(alpha) * (scratch.g / 255);
  const ab = clamp01(alpha) * (scratch.b / 255);
  const curR = out[offset] / 255;
  const curG = out[offset + 1] / 255;
  const curB = out[offset + 2] / 255;
  out[offset] = (1 - (1 - curR) * (1 - ar)) * 255;
  out[offset + 1] = (1 - (1 - curG) * (1 - ag)) * 255;
  out[offset + 2] = (1 - (1 - curB) * (1 - ab)) * 255;
}

/** Source-over-composites `scratch * alpha` onto whatever is already at
 *  `offset` — `canvas-renderer.ts`'s `drawChase` never sets
 *  `globalCompositeOperation`, so its 16 trailing-ghost fills blend with the
 *  canvas default, `"source-over"`, not `"screen"`. That matters here: the
 *  ghosts overlap heavily (`CHASE_RADIUS` is far larger than the per-step
 *  spacing), and `screen` keeps adding brightness where overlapping
 *  source-over draws would instead let the most recent (dimmer, farther back
 *  in the trail) ghost win over what is already there — the tail reads
 *  visibly softer and dimmer under `screen` than the canvas original.
 *  Unlike `screenBlend`, this is order-dependent (source-over is not
 *  commutative), so callers must composite ghosts in the same head-to-tail
 *  order `drawChase` painted them in — see `evalChase`. */
function overBlend(out: Uint8ClampedArray, offset: number, alpha: number): void {
  const a = clamp01(alpha);
  out[offset] = scratch.r * a + out[offset] * (1 - a);
  out[offset + 1] = scratch.g * a + out[offset + 1] * (1 - a);
  out[offset + 2] = scratch.b * a + out[offset + 2] * (1 - a);
}

/* ------------------------------------------------------------- geometry */

function uOf(layout: LedLayout, col: number): number {
  return layout.cols > 1 ? col / (layout.cols - 1) : 0;
}

function vOf(layout: LedLayout, row: number): number {
  return layout.rows > 1 ? row / (layout.rows - 1) : 0;
}

/** True when `wave`/`rain` should run along u instead of v — see the module
 *  doc comment's "DOMINANT AXIS" section. */
function wideThinFallsBackToU(layout: LedLayout): boolean {
  return layout.rows < 3;
}

/* ---------------------------------------------------------- radial falloff */

/** Piecewise-linear approximation of `canvas-renderer.ts`'s 4-stop radial
 *  gradient (`0 -> 0.85`, `0.4 -> 0.55`, `0.75 -> 0.22`, `1 -> 0`), used by
 *  `blob`/`plasma`/`flicker` wherever the canvas version built a
 *  `createRadialGradient` with those exact stops. `distRatio` is
 *  distance-from-centre divided by the lobe's radius. */
function blobFalloff(distRatio: number): number {
  if (distRatio >= 1) return 0;
  if (distRatio <= 0.4) return 0.85 - (0.85 - 0.55) * (distRatio / 0.4);
  if (distRatio <= 0.75) return 0.55 - (0.55 - 0.22) * ((distRatio - 0.4) / 0.35);
  return 0.22 - 0.22 * ((distRatio - 0.75) / 0.25);
}

/* --------------------------------------------------------------- clearing */

/** Zero-fills the buffer — the "off" LED field: no colour, no bloom, no
 *  motion. Callers use this directly for the ledger's `unknown` mode (see the
 *  spec's "Rules inherited from the current stage" #1); `evaluateLedField`
 *  never guesses on a caller's behalf. */
export function clearLedField(out: Uint8ClampedArray): void {
  out.fill(0);
}

/* ------------------------------------------------------------- archetypes */

const BLOB_COUNT = 3;
const BLOB_WANDER_SCALE = 1;
const BLOB_COLOR_CYCLE = 0.5;

const PLASMA_COUNT = 4;
const PLASMA_WANDER_SCALE = 0.16;
const PLASMA_COLOR_CYCLE = 1.6;

/** Shared body for `blob`/`plasma`: `canvas-renderer.ts`'s `drawBlobField`,
 *  ported from "N soft radial gradients over a 2D region" to "N soft radial
 *  contributions evaluated at one LED's (u, v)". Screen-blended exactly as
 *  the canvas version composited its lobes. */
function evalBlobFamily(
  layout: LedLayout,
  spec: MotionSpec,
  parsed: ParsedPalette,
  t: number,
  count: number,
  wanderScale: number,
  colorCycle: number,
  u: number,
  v: number,
  out: Uint8ClampedArray,
  offset: number,
): void {
  const period = Math.max(spec.periodSec, 0.1) * wanderScale;
  const baseRadius = 0.55;
  out[offset] = 0;
  out[offset + 1] = 0;
  out[offset + 2] = 0;
  for (let i = 0; i < count; i++) {
    const phase = (i / count) * Math.PI * 2;
    const slowT = (t / period) * 2 * Math.PI;
    const nx = wander(slowT + phase, i * 7.1);
    const ny = wander(slowT * 0.8 + phase + 1.7, i * 3.3 + 11);
    const cx = 0.5 + 0.32 * nx;
    const cy = 0.5 + 0.32 * ny;
    const colorT = i / count + (t / period) * colorCycle;
    const radius = baseRadius * (0.78 + 0.22 * Math.sin(slowT + phase));
    const du = axisDistance(u, cx, layout.wrapCol);
    const dv = v - cy;
    const dist = Math.sqrt(du * du + dv * dv);
    const alpha = blobFalloff(dist / Math.max(radius, 0.0001)) * spec.intensity;
    if (alpha <= 0) continue;
    sampleCyclic(parsed, colorT);
    screenBlend(out, offset, alpha);
  }
}

/** `canvas-renderer.ts`'s `drawBreathe`: one flat colour, alpha oscillating
 *  gently — the static-color fallback and the zero-regression case. Uniform
 *  across every LED, which is exactly what the golden test asserts. */
function evalBreathe(spec: MotionSpec, parsed: ParsedPalette, t: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const osc = 0.96 + 0.04 * Math.sin((t / period) * 2 * Math.PI);
  sampleCyclic(parsed, 0);
  writeScaled(out, offset, clamp01(spec.intensity * osc));
}

/** `canvas-renderer.ts`'s `drawGradientDrift`: a rotating linear gradient.
 *  `(u, v)` is projected onto the rotating axis to get the same 0..1 gradient
 *  parameter the canvas version built from `createLinearGradient`'s two
 *  rotating endpoints. */
function evalGradientDrift(spec: MotionSpec, parsed: ParsedPalette, t: number, u: number, v: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const angle = (t / period) * 2 * Math.PI;
  const dx = -Math.cos(angle);
  const dy = -Math.sin(angle);
  // x0 = (0.5 + 0.5cos, 0.5 + 0.5sin); s is the projection of (u,v) - x0 onto
  // the unit vector (dx, dy), which is exactly the gradient's 0..1 parameter
  // since |x1 - x0| = 1 in this normalized space.
  const x0u = 0.5 + 0.5 * Math.cos(angle);
  const x0v = 0.5 + 0.5 * Math.sin(angle);
  const s = (u - x0u) * dx + (v - x0v) * dy;
  sampleClamped(parsed, s);
  writeScaled(out, offset, spec.intensity);
}

/** `canvas-renderer.ts`'s `drawWave`: bands sweeping along the dominant axis.
 *  The canvas version discretized into 24 bands purely as a rasterization
 *  artifact of painting a continuous gradient; an LED field is already
 *  discrete by LED position, so this samples the same continuous formula
 *  directly at each LED's coordinate on the dominant axis. */
function evalWave(layout: LedLayout, spec: MotionSpec, parsed: ParsedPalette, t: number, u: number, v: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const useU = wideThinFallsBackToU(layout);
  const p = useU ? u : v;
  const phase = (t / period) * 2 * Math.PI;
  const wobble = Math.sin(phase + p * Math.PI * 3) * 0.5 + 0.5;
  sampleCyclic(parsed, p + t / period);
  writeScaled(out, offset, clamp01(spec.intensity * (0.35 + 0.4 * wobble)));
}

const CHASE_STEPS = 16;
const CHASE_TAIL_LENGTH = 0.22;
const CHASE_RADIUS = 0.06;

/** `canvas-renderer.ts`'s `drawChase`: a moving dot with a fading tail of
 *  `CHASE_STEPS` trailing ghosts, composited with `overBlend` in the same
 *  head-to-tail order `drawChase` painted them (source-over, not screen — see
 *  `overBlend`'s doc comment). Always travels along u — see the module doc
 *  comment's "DOMINANT AXIS" section for why that is not a per-layout choice
 *  the way wave/rain's is. Uniform across the secondary axis (every row in
 *  the lit column takes the same value), which is what makes "exactly one
 *  bright region" a true structural property to test against. */
function evalChase(layout: LedLayout, spec: MotionSpec, parsed: ParsedPalette, t: number, u: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const progress = frac(t / period);
  out[offset] = 0;
  out[offset + 1] = 0;
  out[offset + 2] = 0;
  for (let i = 0; i < CHASE_STEPS; i++) {
    const wrapped = frac(progress - (i / CHASE_STEPS) * CHASE_TAIL_LENGTH);
    const d = axisDistance(u, wrapped, layout.wrapCol);
    const falloff = Math.max(0, 1 - d / CHASE_RADIUS);
    if (falloff <= 0) continue;
    const alpha = spec.intensity * (1 - i / CHASE_STEPS) * falloff;
    if (alpha <= 0) continue;
    sampleCyclic(parsed, wrapped);
    overBlend(out, offset, alpha);
  }
}

const SPARKLE_TWINKLE_THRESHOLD = 0.35;

/**
 * `canvas-renderer.ts`'s `drawSparkle`: the canvas version scattered a fixed
 * `count = 18` continuously-positioned points across the region, each with a
 * per-point seeded twinkle. An LED field already has a natural, finite
 * population of candidate points — the LEDs themselves — so this treats
 * every LED as its own twinkle site, seeded by its own index rather than by
 * an arbitrary point index. That is a closer fit to "an archetype drives
 * emitters" than picking 18 points regardless of how many LEDs exist, and it
 * keeps the same twinkle-in/twinkle-out formula and threshold.
 */
function evalSparkle(spec: MotionSpec, parsed: ParsedPalette, t: number, ledIdx: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const seed = ledIdx * 12.9898;
  const twinkle = 0.5 + 0.5 * Math.sin((t / period) * 2 * Math.PI * (1 + frac(seed)) + seed);
  if (twinkle < SPARKLE_TWINKLE_THRESHOLD) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    return;
  }
  const alpha = spec.intensity * ((twinkle - SPARKLE_TWINKLE_THRESHOLD) / (1 - SPARKLE_TWINKLE_THRESHOLD));
  sampleCyclic(parsed, frac(seed * 0.37));
  writeScaled(out, offset, alpha);
}

/** `canvas-renderer.ts`'s `drawFlicker`: a single global jitter value (a sum
 *  of three non-harmonic sine terms, kept verbatim) shaped by a soft radial
 *  vignette centred low in the field — the canvas version's gradient centred
 *  at `(0.5, 0.65)` fading out over 0.7 of the region. */
function evalFlicker(layout: LedLayout, spec: MotionSpec, parsed: ParsedPalette, t: number, u: number, v: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const jitter = 0.5 + 0.25 * Math.sin(t * 7.3) + 0.15 * Math.sin(t * 13.1 + 1.4) + 0.1 * Math.sin(t * 2.2 + 0.7);
  const alpha = clamp01(spec.intensity * (0.55 + 0.45 * jitter));
  // Matches canvas-renderer.ts's literal `Math.sin(t / period)` — no extra
  // 2*PI factor there, so this keeps the same (much slower) drift cadence
  // rather than "fixing" what reads as a typo in the original.
  sampleCyclic(parsed, 0.5 + 0.5 * Math.sin(t / period));
  const du = axisDistance(u, 0.5, layout.wrapCol);
  const dv = v - 0.65;
  const dist = Math.sqrt(du * du + dv * dv);
  const vignette = clamp01(1 - dist / 0.7);
  writeScaled(out, offset, alpha * vignette);
}

/** `canvas-renderer.ts`'s `drawStrobe`: a hard on/off flash, uniform across
 *  the whole field, cycling through the palette one flash at a time. */
function evalStrobe(spec: MotionSpec, parsed: ParsedPalette, t: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.2);
  const cyclePos = frac(t / period);
  if (cyclePos >= 0.12) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    return;
  }
  const n = Math.max(1, parsed.r.length);
  const idx = Math.floor(t / period) % n;
  sampleCyclic(parsed, idx / n);
  writeScaled(out, offset, spec.intensity);
}

const RAIN_LENGTH = 0.16;

/**
 * `canvas-renderer.ts`'s `drawRain`: falling comet-tail streaks. The canvas
 * version fixed `streaks = 14` independent of resolution; here one streak
 * channel exists per index along the *secondary* axis (the axis rain does
 * not travel along), so a 12-column H6022 gets 12 streaks and a 2-row H6056
 * gets 2 — a natural fit rather than an arbitrary constant. Travels along
 * the dominant axis chosen by `wideThinFallsBackToU` (see the module doc
 * comment), same as `wave`.
 */
function evalRain(layout: LedLayout, spec: MotionSpec, parsed: ParsedPalette, t: number, row: number, col: number, u: number, v: number, out: Uint8ClampedArray, offset: number): void {
  const period = Math.max(spec.periodSec, 0.1);
  const useU = wideThinFallsBackToU(layout);
  const p = useU ? u : v;
  const secondaryIndex = useU ? row : col;
  const seed = secondaryIndex * 7.31;
  const speed = 0.6 + frac(seed * 3.1) * 0.8;
  const head = frac((t * speed) / period + frac(seed * 5.2));
  const d = axisDistance(p, head, useU && layout.wrapCol);
  if (d >= RAIN_LENGTH) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    return;
  }
  const alpha = spec.intensity * 0.6 * (1 - d / RAIN_LENGTH);
  sampleCyclic(parsed, frac(seed * 0.61));
  writeScaled(out, offset, alpha);
}

/* ----------------------------------------------------------- entry point */

/**
 * Evaluates every archetype's colour at absolute ticker time `t` (seconds)
 * for every LED in `layout`, writing RGB triples into `out` (length
 * `ledCount(layout) * 3`, as returned by `models/types.ts`'s `ledCount`).
 *
 * `out` is fully overwritten LED-by-LED (nothing needs a pre-clear); the
 * caller owns the buffer and this function performs no per-LED allocation.
 */
export function evaluateLedField(spec: MotionSpec, layout: LedLayout, t: number, out: Uint8ClampedArray): void {
  const parsed = getParsedPalette(spec.palette);
  const archetype: MotionArchetype = spec.archetype;

  for (let row = 0; row < layout.rows; row++) {
    const v = vOf(layout, row);
    for (let col = 0; col < layout.cols; col++) {
      const u = uOf(layout, col);
      const idx = ledIndex(layout, row, col);
      const offset = idx * 3;

      switch (archetype) {
        case "blob":
          evalBlobFamily(layout, spec, parsed, t, BLOB_COUNT, BLOB_WANDER_SCALE, BLOB_COLOR_CYCLE, u, v, out, offset);
          break;
        case "plasma":
          evalBlobFamily(layout, spec, parsed, t, PLASMA_COUNT, PLASMA_WANDER_SCALE, PLASMA_COLOR_CYCLE, u, v, out, offset);
          break;
        case "wave":
          evalWave(layout, spec, parsed, t, u, v, out, offset);
          break;
        case "chase":
          evalChase(layout, spec, parsed, t, u, out, offset);
          break;
        case "sparkle":
          evalSparkle(spec, parsed, t, idx, out, offset);
          break;
        case "flicker":
          evalFlicker(layout, spec, parsed, t, u, v, out, offset);
          break;
        case "strobe":
          evalStrobe(spec, parsed, t, out, offset);
          break;
        case "gradient-drift":
          evalGradientDrift(spec, parsed, t, u, v, out, offset);
          break;
        case "rain":
          evalRain(layout, spec, parsed, t, row, col, u, v, out, offset);
          break;
        case "breathe":
        default:
          evalBreathe(spec, parsed, t, out, offset);
          break;
      }
    }
  }
}

/* ------------------------------------------------------- effect playback */

/**
 * Literal keyframe playback for `kind === "effect"`, the counterpart to
 * `motion-engine/effect-playback.ts`'s `drawEffectFrame` for the 3D stage.
 * Samples the real per-segment colours via `frameAt` (unchanged, reused) and
 * spreads the cloud's linear segment rail across the matrix's COLUMNS: every
 * row in a column takes that column's segment colour. See the module doc
 * comment's "EFFECT PLAYBACK" section for why this is a template mapping,
 * not the firmware's real interpolation rule.
 *
 * A layout with more columns than segments repeats each segment across a
 * proportional run of columns; a single-emitter (1x1) layout takes the
 * lowest-numbered segment's colour, since one LED cannot show a rail.
 */
export function writeEffectFrame(effect: EffectDescriptor, layout: LedLayout, nowMs: number, out: Uint8ClampedArray): void {
  const colors = frameAt(effect, nowMs);
  const ids = Object.keys(colors)
    .map(Number)
    .sort((a, b) => a - b);

  if (ids.length === 0) {
    clearLedField(out);
    return;
  }

  for (let col = 0; col < layout.cols; col++) {
    const segPos = Math.min(ids.length - 1, Math.floor((col * ids.length) / layout.cols));
    const id = ids[segPos]!;
    const [r, g, b] = colors[id]!;
    for (let row = 0; row < layout.rows; row++) {
      const offset = ledIndex(layout, row, col) * 3;
      out[offset] = r;
      out[offset + 1] = g;
      out[offset + 2] = b;
    }
  }
}

