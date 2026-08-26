/**
 * Literal playback path for `kind === "effect"` (WEBUI_V3_SPEC.md §4.2,
 * §4.5 layer 3). A TS port of `govee_cli/commands/effect.py`'s
 * `_color_at`/`_frames` sampling, driven by a real `EffectDescriptor` and
 * its `startedAt` wall-clock anchor — no guessing when real per-segment
 * color/time data already exists.
 *
 * Pure functions of `(effect, wallClockMs)`. The consumer is now
 * `lamp3d/led-field.ts`'s `writeEffectFrame`, which calls `frameAt` once
 * per tick and spreads the returned per-segment colours across the model's
 * real LED placements. The 2D `drawEffectFrame` that used to live here went
 * with the Canvas2D stage: it painted normalized `geometry.ts` regions, and
 * those normalized 2D bounds have no meaning once the light leaves actual
 * emitters in 3D. Everything below is GL-free and stays that way — a pure
 * sampler is what makes the honesty rules unit-testable in the Node env.
 */

import type { EffectDescriptor } from "./types";

type Rgb = [number, number, number];
type Keyframes = EffectDescriptor["segments"][number]["keyframes"];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/**
 * Port of `effect.py`'s `_color_at`: linear RGB interpolation between the
 * two keyframes bracketing `tMs`, clamped to the first/last keyframe
 * outside their range. Uses `Math.floor` (not `Math.round`) to match
 * Python's `int()` truncation exactly.
 */
export function colorAt(keyframes: Keyframes, tMs: number): Rgb {
  if (keyframes.length === 0) return [255, 255, 255];
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  if (tMs <= first.t) return hexToRgb(first.color);
  if (tMs >= last.t) return hexToRgb(last.color);

  for (let i = 0; i < keyframes.length - 1; i++) {
    const kf0 = keyframes[i]!;
    const kf1 = keyframes[i + 1]!;
    if (kf0.t <= tMs && tMs <= kf1.t) {
      const frac = kf1.t > kf0.t ? (tMs - kf0.t) / (kf1.t - kf0.t) : 0;
      const c0 = hexToRgb(kf0.color);
      const c1 = hexToRgb(kf1.color);
      return [
        Math.floor(c0[0] + (c1[0] - c0[0]) * frac),
        Math.floor(c0[1] + (c1[1] - c0[1]) * frac),
        Math.floor(c0[2] + (c1[2] - c0[2]) * frac),
      ];
    }
  }
  return hexToRgb(last.color);
}

/** Port of `effect.py`'s `total_ms = max(kf.t for seg ... for kf ...)`. */
export function totalDurationMs(effect: EffectDescriptor): number {
  let max = 0;
  for (const seg of effect.segments) {
    for (const kf of seg.keyframes) {
      if (kf.t > max) max = kf.t;
    }
  }
  return max;
}

/**
 * The single frame every segment shows at absolute wall-clock `nowMs` —
 * the live-playback counterpart to `_frames()`, which yields one whole
 * pass; the canvas only ever needs "what does this instant look like."
 * Looping effects wrap `elapsed % total`; non-looping effects clamp to the
 * final frame once `elapsed` runs past the end (mirrors the CLI/sidecar's
 * own natural-completion freeze before the ledger downgrades to `basic`).
 */
export function frameAt(effect: EffectDescriptor, nowMs: number): Record<number, Rgb> {
  const total = totalDurationMs(effect);
  const colors: Record<number, Rgb> = {};
  if (total <= 0) return colors;

  const elapsed = nowMs - effect.startedAt;
  const t = effect.loop ? ((elapsed % total) + total) % total : Math.min(Math.max(elapsed, 0), total);

  for (const seg of effect.segments) {
    colors[seg.id] = colorAt(seg.keyframes, t);
  }
  return colors;
}
