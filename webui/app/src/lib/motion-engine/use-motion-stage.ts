"use client";

/**
 * React hook wiring `canvasRef` + geometry + `MotionSpec` into the driver
 * (WEBUI_V3_SPEC.md §4.2, §4.4, §4.9): DPR cap (≤2x regardless of the
 * device's real DPR), resize, `IntersectionObserver`-gated
 * subscribe/unsubscribe, and the reduced-motion kill switch.
 *
 * No per-frame React state anywhere — every mutable value the draw closure
 * needs (geometry/spec/effect) lives in a ref updated on render, so prop
 * changes never re-subscribe the driver or re-run the resize/observer
 * effects.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";

import { drawArchetype } from "./canvas-renderer";
import { canSubscribePlate, subscribe } from "./driver";
import { drawEffectFrame, frameAt } from "./effect-playback";
import { regionRectPx } from "./geometry";
import type { DeviceGeometry, EffectDescriptor, MotionSpec } from "./types";

/** Resolution cap regardless of the device's real DPR — a 3x iPhone Pro DPR
 *  is wasted on soft blurry light patterns (§4.1). */
const MAX_DPR = 2;

export interface UseMotionStageParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  geometry: DeviceGeometry;
  spec: MotionSpec;
  variant: "full" | "mini";
  /**
   * Optional literal-playback data (§4.5 layer 3). When present *and*
   * `variant === "full"`, each tick samples real per-segment color from
   * `effect-playback.ts` instead of running the archetype renderer — real
   * data beats a name guess. Not part of §4.4's literal parameter list;
   * added as an optional field so the four required fields still match it
   * exactly. Absent (or ignored on `"mini"`) falls through to the
   * `spec`-driven archetype render, which for an effect-kind mode is
   * already `classify.ts`'s statistical "compact preview" (§4.5).
   */
  effect?: EffectDescriptor;
}

function drawStatic(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  geometry: DeviceGeometry,
  spec: MotionSpec,
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const color = spec.palette.colors[0] ?? "#ffb26b";
  for (const region of geometry.regions) {
    const rect = regionRectPx(region, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
}

export function useMotionStage(params: UseMotionStageParams): void {
  const { canvasRef, geometry, spec, variant, effect } = params;
  const reducedMotion = useReducedMotion();

  // Always-current values for the draw closure below, without re-running
  // the subscribe effect (which only depends on identity-stable things:
  // the canvas element, reduced-motion, and variant) on every render.
  const geometryRef = React.useRef(geometry);
  geometryRef.current = geometry;
  const specRef = React.useRef(spec);
  specRef.current = spec;
  const effectRef = React.useRef(effect);
  effectRef.current = effect;

  const ctxRef = React.useRef<CanvasRenderingContext2D | null>(null);

  // DPR-capped canvas sizing, kept in sync with the element's rendered CSS
  // size. Runs on mount and whenever the element's box changes.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined" || typeof ResizeObserver === "undefined") return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctxRef.current = canvas.getContext("2d");
      if (reducedMotion && ctxRef.current) {
        drawStatic(canvas, ctxRef.current, geometryRef.current, specRef.current);
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
     
  }, [canvasRef, reducedMotion]);

  // §4.9: reduced motion draws exactly one static representative frame (the
  // first palette stop, no animation) and never subscribes to the ticker at
  // all. Re-runs whenever the resolved spec/geometry actually change so the
  // static frame still tracks the current mode even without a ticker.
  React.useEffect(() => {
    if (!reducedMotion) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    drawStatic(canvas, ctx, geometry, spec);
  }, [reducedMotion, geometry, spec, canvasRef]);

  // The animated path: visibility-gated subscribe/unsubscribe against the
  // one shared ticker. Skipped entirely under reduced motion.
  React.useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;

    const id = `motion-${variant}-${Math.random().toString(36).slice(2)}`;
    const priority: "hero" | "plate" = variant === "full" ? "hero" : "plate";
    let unsubscribe: (() => void) | null = null;

    const start = () => {
      if (unsubscribe) return;
      // Plates beyond the concurrency cap never acquire a canvas draw loop —
      // the canvas stays blank/transparent and whatever CSS layer sits
      // beneath it (Breath/Halo) shows through, per §4.1.
      if (priority === "plate" && !canSubscribePlate()) return;
      unsubscribe = subscribe({
        id,
        priority,
        draw: (_placeholderCtx, t) => {
          const canvasEl = canvasRef.current;
          const ctx = ctxRef.current;
          if (!canvasEl || !ctx) return;
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

          const currentEffect = effectRef.current;
          if (variant === "full" && currentEffect) {
            const colors = frameAt(currentEffect, t * 1000);
            drawEffectFrame(ctx, geometryRef.current, canvasEl.width, canvasEl.height, colors);
            return;
          }

          for (const region of geometryRef.current.regions) {
            drawArchetype({ ctx, region, width: canvasEl.width, height: canvasEl.height, t, spec: specRef.current });
          }
        },
      });
    };

    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) start();
        else stop();
      },
      { threshold: 0.01 },
    );
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      stop();
    };
  }, [canvasRef, reducedMotion, variant]);
}
