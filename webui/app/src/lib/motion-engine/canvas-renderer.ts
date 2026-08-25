/**
 * Per-archetype Canvas2D draw functions (WEBUI_V3_SPEC.md §4.2, §4.8).
 *
 * Every function has the same shape: fill the given region (already clipped
 * to its bounds) using `spec.palette`/`periodSec`/`intensity`, driven purely
 * by the shared ticker's absolute time `t` (seconds) — no per-function
 * state, no `Math.random()` in anything that needs to look the same between
 * renders of the same name (only `sparkle`/`rain`'s point layout use a
 * seeded pseudo-random placement, which is itself deterministic per index).
 *
 * Softness comes from many-stop radial gradients, never `ctx.filter: blur()`
 * (cheaper and more consistent across Safari versions, per §4.8).
 */

import { clipToRegion, regionRectPx } from "./geometry";
import type { GeometryRegion, MotionArchetype, MotionSpec } from "./types";

export interface DrawParams {
  ctx: CanvasRenderingContext2D;
  region: GeometryRegion;
  /** canvas pixel width/height, already DPR-scaled */
  width: number;
  height: number;
  /** absolute ticker time, seconds */
  t: number;
  spec: MotionSpec;
}

export type DrawFn = (params: DrawParams) => void;

/* --------------------------------------------------------------- utilities */

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function hexToRgbTriplet(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgbTriplet(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha).toFixed(3)})`;
}

/** Interpolates linearly across a palette's stops at `t` (0..1, wraps). A
 *  single-stop palette (the `breathe` static-color case) just returns that
 *  color for every `t`. */
function interpolatePaletteColor(colors: string[], t: number): string {
  if (colors.length === 0) return "#ffffff";
  if (colors.length === 1) return colors[0]!;
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * colors.length;
  const i0 = Math.floor(scaled) % colors.length;
  const i1 = (i0 + 1) % colors.length;
  const frac0 = scaled - Math.floor(scaled);
  const c0 = hexToRgbTriplet(colors[i0]!);
  const c1 = hexToRgbTriplet(colors[i1]!);
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * frac0);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * frac0);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * frac0);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Cheap smooth "wander" in roughly [-1, 1] — a sum of two non-harmonic
 *  sine terms, used in place of real Perlin/value noise for blob centers
 *  (§4.8: "slow 2D value-noise", implemented here as a lightweight
 *  approximation cheap enough to run per-blob, per-region, per-frame). */
function wander(phase: number, seed: number): number {
  return 0.6 * Math.sin(phase + seed) + 0.4 * Math.sin(phase * 0.37 + seed * 1.7 + 1.3);
}

/* -------------------------------------------------------------------- blob */

function drawBlobField(
  { ctx, region, width, height, t, spec }: DrawParams,
  opts: { count: number; wanderPeriodScale: number; colorCycle: number },
): void {
  const rect = regionRectPx(region, width, height);
  const colors = spec.palette.colors;
  const period = Math.max(spec.periodSec, 0.1) * opts.wanderPeriodScale;
  const baseRadius = Math.max(rect.w, rect.h) * 0.55;

  ctx.save();
  clipToRegion(ctx, region, width, height);
  const prevComposite = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < opts.count; i++) {
    const phase = (i / opts.count) * Math.PI * 2;
    const slowT = (t / period) * 2 * Math.PI;
    const nx = wander(slowT + phase, i * 7.1);
    const ny = wander(slowT * 0.8 + phase + 1.7, i * 3.3 + 11);
    const cx = rect.x + rect.w * (0.5 + 0.32 * nx);
    const cy = rect.y + rect.h * (0.5 + 0.32 * ny);
    const colorT = i / opts.count + (t / period) * opts.colorCycle;
    const color = interpolatePaletteColor(colors, colorT);
    const radius = baseRadius * (0.78 + 0.22 * Math.sin(slowT + phase));

    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(radius, 1));
    gradient.addColorStop(0, hexToRgba(color, 0.85 * spec.intensity));
    gradient.addColorStop(0.4, hexToRgba(color, 0.55 * spec.intensity));
    gradient.addColorStop(0.75, hexToRgba(color, 0.22 * spec.intensity));
    gradient.addColorStop(1, hexToRgba(color, 0));

    ctx.fillStyle = gradient;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  ctx.globalCompositeOperation = prevComposite;
  ctx.restore();
}

/** 3 soft radial-gradient blobs, slow drift, `screen` compositing so
 *  overlaps blend into soft violet rather than harsh edges (§4.8). */
export function drawBlob(params: DrawParams): void {
  drawBlobField(params, { count: 3, wanderPeriodScale: 1, colorCycle: 0.5 });
}

/** The music-mode "Vivid" archetype — a faster, denser blob field so it
 *  reads as an audio-reactive plasma field rather than a lava lamp. */
export function drawPlasma(params: DrawParams): void {
  drawBlobField(params, { count: 4, wanderPeriodScale: 0.16, colorCycle: 1.6 });
}

/* ---------------------------------------------------------------- breathe */

/** The static-color fallback: one flat fill, alpha oscillating gently
 *  (matches `stage.tsx`'s existing CSS `Breath` cadence — this archetype is
 *  the zero-regression case). */
export function drawBreathe({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const color = spec.palette.colors[0] ?? "#ffb26b";
  const osc = 0.96 + 0.04 * Math.sin((t / period) * 2 * Math.PI);
  const alpha = clamp01(spec.intensity) * osc;

  ctx.save();
  clipToRegion(ctx, region, width, height);
  ctx.fillStyle = hexToRgba(color, alpha);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/* ---------------------------------------------------------- gradient-drift */

export function drawGradientDrift({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const angle = (t / period) * 2 * Math.PI;
  const x0 = rect.x + rect.w * (0.5 + 0.5 * Math.cos(angle));
  const y0 = rect.y + rect.h * (0.5 + 0.5 * Math.sin(angle));
  const x1 = rect.x + rect.w * (0.5 - 0.5 * Math.cos(angle));
  const y1 = rect.y + rect.h * (0.5 - 0.5 * Math.sin(angle));

  const stops = spec.palette.colors.length > 1 ? spec.palette.colors : [spec.palette.colors[0]!, spec.palette.colors[0]!];
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => gradient.addColorStop(i / (stops.length - 1), hexToRgba(c, spec.intensity)));

  ctx.save();
  clipToRegion(ctx, region, width, height);
  ctx.fillStyle = gradient;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/* ------------------------------------------------------------------- wave */

export function drawWave({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const colors = spec.palette.colors;
  const bands = 24;

  ctx.save();
  clipToRegion(ctx, region, width, height);
  const bandH = rect.h / bands + 1;
  for (let i = 0; i <= bands; i++) {
    const bandFrac = i / bands;
    const y = rect.y + rect.h * bandFrac;
    const phase = (t / period) * 2 * Math.PI;
    const wobble = Math.sin(phase + bandFrac * Math.PI * 3) * 0.5 + 0.5;
    const color = interpolatePaletteColor(colors, bandFrac + t / period);
    ctx.fillStyle = hexToRgba(color, spec.intensity * (0.35 + 0.4 * wobble));
    ctx.fillRect(rect.x, y, rect.w, bandH);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ chase */

export function drawChase({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const colors = spec.palette.colors;
  const progress = frac(t / period);
  const steps = 16;
  const tailLength = 0.22;
  const r = Math.max(rect.w, rect.h) * 0.06;

  ctx.save();
  clipToRegion(ctx, region, width, height);
  for (let i = 0; i < steps; i++) {
    const wrapped = frac(progress - (i / steps) * tailLength);
    const cx = rect.x + rect.w * wrapped;
    const cy = rect.y + rect.h * 0.5;
    const alpha = spec.intensity * (1 - i / steps);
    const color = interpolatePaletteColor(colors, wrapped);

    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 1));
    gradient.addColorStop(0, hexToRgba(color, alpha));
    gradient.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* --------------------------------------------------------------- sparkle */

export function drawSparkle({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const colors = spec.palette.colors;
  const count = 18;
  const pointR = Math.max(1.4, Math.min(rect.w, rect.h) * 0.02);

  ctx.save();
  clipToRegion(ctx, region, width, height);
  for (let i = 0; i < count; i++) {
    const seed = i * 12.9898;
    const px = rect.x + rect.w * frac(Math.sin(seed) * 43758.5453);
    const py = rect.y + rect.h * frac(Math.sin(seed * 1.7 + 3.1) * 12543.123);
    // Flicker-in/flicker-out twinkle — this is also the "flicker" half of
    // the music-mode "Vibrate" composite (§4.7): sparkle points that
    // themselves flicker read as both at once without a second archetype.
    const twinkle = 0.5 + 0.5 * Math.sin((t / period) * 2 * Math.PI * (1 + frac(seed)) + seed);
    if (twinkle < 0.35) continue;
    const alpha = spec.intensity * ((twinkle - 0.35) / 0.65);
    const color = interpolatePaletteColor(colors, frac(seed * 0.37));
    ctx.beginPath();
    ctx.fillStyle = hexToRgba(color, alpha);
    ctx.arc(px, py, pointR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* --------------------------------------------------------------- flicker */

export function drawFlicker({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const colors = spec.palette.colors;
  const jitter =
    0.5 + 0.25 * Math.sin(t * 7.3) + 0.15 * Math.sin(t * 13.1 + 1.4) + 0.1 * Math.sin(t * 2.2 + 0.7);
  const alpha = clamp01(spec.intensity * (0.55 + 0.45 * jitter));
  const color = interpolatePaletteColor(colors, 0.5 + 0.5 * Math.sin(t / period));

  ctx.save();
  clipToRegion(ctx, region, width, height);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h * 0.65;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rect.w, rect.h) * 0.7);
  gradient.addColorStop(0, hexToRgba(color, alpha));
  gradient.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/* ---------------------------------------------------------------- strobe */

export function drawStrobe({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.2);
  const colors = spec.palette.colors;
  const cyclePos = frac(t / period);
  const on = cyclePos < 0.12;

  ctx.save();
  clipToRegion(ctx, region, width, height);
  if (on) {
    const idx = Math.floor(t / period) % colors.length;
    const color = colors[idx] ?? colors[0] ?? "#ffffff";
    ctx.fillStyle = hexToRgba(color, spec.intensity);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------- rain */

export function drawRain({ ctx, region, width, height, t, spec }: DrawParams): void {
  const rect = regionRectPx(region, width, height);
  const period = Math.max(spec.periodSec, 0.1);
  const colors = spec.palette.colors;
  const streaks = 14;
  const len = rect.h * 0.16;
  const lineW = Math.max(1, rect.w * 0.006);

  ctx.save();
  clipToRegion(ctx, region, width, height);
  for (let i = 0; i < streaks; i++) {
    const seed = i * 7.31;
    const xFrac = frac(Math.sin(seed) * 91731.31);
    const speed = 0.6 + frac(seed * 3.1) * 0.8;
    const yFrac = frac((t * speed) / period + frac(seed * 5.2));
    const x = rect.x + rect.w * xFrac;
    const yTop = rect.y + rect.h * yFrac;
    const color = interpolatePaletteColor(colors, frac(seed * 0.61));

    const gradient = ctx.createLinearGradient(x, yTop, x, yTop + len);
    gradient.addColorStop(0, hexToRgba(color, 0));
    gradient.addColorStop(0.6, hexToRgba(color, spec.intensity * 0.6));
    gradient.addColorStop(1, hexToRgba(color, 0));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yTop + len);
    ctx.stroke();
  }
  ctx.restore();
}

/* --------------------------------------------------------------- dispatch */

export const ARCHETYPE_RENDERERS: Record<MotionArchetype, DrawFn> = {
  breathe: drawBreathe,
  blob: drawBlob,
  plasma: drawPlasma,
  wave: drawWave,
  chase: drawChase,
  sparkle: drawSparkle,
  flicker: drawFlicker,
  strobe: drawStrobe,
  "gradient-drift": drawGradientDrift,
  rain: drawRain,
};

export function drawArchetype(params: DrawParams): void {
  const renderer = ARCHETYPE_RENDERERS[params.spec.archetype] ?? drawBreathe;
  renderer(params);
}
