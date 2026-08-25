"use client";

/**
 * Thin component: `<canvas>` + the hook (WEBUI_V3_SPEC.md §4.2). Meant to be
 * mounted inside `BarsStage`/`MatrixLampStage`/`OrbStage` as a layer above
 * `CYLINDER_SHADING`'s base but below the existing `Halo` glow, replacing
 * `EmissionLayers`' lit-color layer only when `ActiveMode.mode !== "basic"`/
 * `"off"` — that wiring is T12's job (`stage.tsx`); this component only
 * needs a resolved `geometry` + `MotionSpec` (and, for literal effect
 * playback on the hero stage, an `EffectDescriptor`).
 *
 * SSR-safe: the canvas renders identically server/client (empty), and every
 * draw happens imperatively inside `useMotionStage`'s effects.
 */

import * as React from "react";

import { useMotionStage } from "./use-motion-stage";
import type { DeviceGeometry, EffectDescriptor, MotionSpec } from "./types";

export interface MotionCanvasProps {
  geometry: DeviceGeometry;
  spec: MotionSpec;
  /** Real keyframe data for `kind === "effect"` — see `use-motion-stage.ts`
   *  for when this takes over from the archetype render. */
  effect?: EffectDescriptor;
  /** full = device console centerpiece (hero); mini = console plate preview */
  variant?: "full" | "mini";
  className?: string;
}

export function MotionCanvas({ geometry, spec, effect, variant = "full", className }: MotionCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  useMotionStage({ canvasRef, geometry, spec, variant, effect });

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
