"use client";

import * as React from "react";
import {
  animate,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
} from "motion/react";

import { springStandard } from "@/lib/motion";

/**
 * h ∈ 0..360, s/l ∈ 0..100 — same shape as `stage/color.ts`'s `Hsl`, kept
 * local so this module (a chrome-layer primitive) has no dependency on the
 * stage renderer. Callers already holding a `Hsl` from that module can pass
 * it straight through.
 */
export type DeviceHsl = readonly [number, number, number];

/**
 * Brightness (1..100, or null while unknown) as a 0..1 emission factor with
 * a visible floor — mirrors `DeviceStage`'s own `brightnessGlow` curve so a
 * card's spill tracks the same weight as the instrument it surrounds. Off
 * collapses straight to zero regardless of the last-known brightness.
 */
function bleedTarget(power: boolean, brightness: number | null): number {
  if (!power) return 0;
  const pct = Math.min(100, Math.max(1, brightness ?? 50));
  return 0.25 + 0.75 * (pct / 100);
}

/**
 * Drives a card's `--dev-hue`/`--dev-sat`/`--dev-light`/`--dev-alpha`
 * custom properties (registered via `@property` in tokens.css) from live
 * device state, per V3_VISUAL_DIRECTION.md §C. Two different update rates,
 * two different mechanisms — the reason this never costs a per-frame JS
 * loop of its own:
 *
 * - Hue/sat/light only change on a state tick (a poll landing, an
 *   optimistic write resolving) — not every animation frame — so they're
 *   written as a plain effect keyed on the color itself. All the smoothing
 *   between an old hue and a new one is delegated to the CSS `transition`
 *   on those `@property`-registered channels (see globals.css's
 *   `.dev-bleed`), never JS ticking. They deliberately hold their last
 *   value through an off transition (see below) rather than resetting.
 * - Alpha (the overall bleed intensity) needs the same continuous,
 *   physically-weighted feel as the rest of the instrument's glow, so it
 *   rides a `motion/react` spring exactly like `DeviceStage`'s `useGlow`
 *   does for the instrument's own emission — but, like `Halo`'s
 *   `--glow-alpha` there, it's written to the DOM *imperatively* via
 *   `useMotionValueEvent`, one level up at the card root, never through
 *   React state. No component re-renders once per animation frame while a
 *   light dims — the shared Canvas2D ticker remains the only per-frame
 *   subscriber in the app.
 *
 * `power === false` (off/offline — callers fold "offline" into `power`
 * themselves) springs alpha to 0 on `springStandard`, matching `useGlow`'s
 * existing on/off physics, while hue/sat/light simply hold — the card
 * fades to flat chassis rather than snapping or drifting toward some
 * default hue on the way down (§C/§G: off is always the calmest state).
 *
 * Reduced motion: alpha jumps straight to its target instead of springing
 * (mirrors `DeviceStage`'s `useWarmth` guard); the CSS-side hue/sat/light
 * transition is already collapsed to ~0ms by globals.css's global
 * `prefers-reduced-motion` rule, so no separate guard is needed there.
 */
export function useDeviceBleed(
  cardRef: React.RefObject<HTMLElement | null>,
  hsl: DeviceHsl,
  power: boolean,
  brightness: number | null,
): void {
  const reduced = useReducedMotion();
  const alpha = useSpring(0, springStandard);

  const [hue, sat, light] = hsl;
  React.useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty("--dev-hue", String(hue));
    el.style.setProperty("--dev-sat", `${sat}%`);
    el.style.setProperty("--dev-light", `${light}%`);
  }, [cardRef, hue, sat, light]);

  const target = bleedTarget(power, brightness);
  React.useEffect(() => {
    if (reduced) {
      alpha.set(target);
      return;
    }
    void animate(alpha, target, springStandard);
  }, [alpha, reduced, target]);

  useMotionValueEvent(alpha, "change", (v) => {
    cardRef.current?.style.setProperty("--dev-alpha", String(v));
  });
}
