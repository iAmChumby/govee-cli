/**
 * One global `requestAnimationFrame` ticker, shared by every mounted motion
 * stage (WEBUI_V3_SPEC.md §4.1, §4.4) — not one loop per stage. Stages
 * register/unregister via `subscribe()`; the ticker starts on the first
 * subscriber and stops on the last (nothing spins while nothing is
 * mounted).
 *
 * Nothing here owns a canvas. Each stage's own `use-motion-stage.ts` closes
 * over its own 2D context (obtained from its own `canvasRef`, re-acquired
 * on resize) inside the `draw` closure it registers, so the `ctx` argument
 * this module threads through `tick()` is a shared placeholder that real
 * subscribers ignore in favor of their own — it exists only so
 * `MotionFrameSubscriber.draw`'s signature matches §4.4 exactly without
 * every call site needing a fake non-null context of its own.
 *
 * Concurrency tier (§4.1): the hero stage always ticks; "plate" (dashboard
 * mini) subscribers are capped so a long dashboard grid doesn't spin up
 * dozens of simultaneous canvas contexts on one iPhone Safari session.
 * `canSubscribePlate()` lets a caller check the cap *before* mounting a
 * canvas at all — a plate beyond the cap should never even acquire a 2D
 * context, per §4.1's "fall back to the existing cheap CSS Breath/Halo loop
 * instead of a redundant canvas context."
 */

import type { MotionFrameSubscriber } from "./types";

/** Start conservative; tune empirically against a real iPhone Safari
 *  session with the full dashboard grid visible, per §4.1. */
export const PLATE_CONCURRENCY_CAP = 4;

const subscribers = new Map<string, MotionFrameSubscriber>();

let rafId: number | null = null;
let lastTs: number | null = null;
let placeholderCtx: CanvasRenderingContext2D | null = null;

function getPlaceholderCtx(): CanvasRenderingContext2D | null {
  if (placeholderCtx) return placeholderCtx;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  placeholderCtx = canvas.getContext("2d");
  return placeholderCtx;
}

function tick(ts: number): void {
  const dt = lastTs === null ? 0 : Math.min((ts - lastTs) / 1000, 0.25);
  lastTs = ts;
  const t = ts / 1000;
  const ctx = getPlaceholderCtx();
  if (ctx) {
    for (const sub of subscribers.values()) {
      try {
        sub.draw(ctx, t, dt);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
           
          console.error(`motion-engine: subscriber "${sub.id}" draw failed`, err);
        }
      }
    }
  }
  rafId = requestAnimationFrame(tick);
}

function ensureRunning(): void {
  if (rafId !== null || typeof window === "undefined") return;
  lastTs = null;
  rafId = requestAnimationFrame(tick);
}

function stopIfIdle(): void {
  if (subscribers.size === 0 && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    lastTs = null;
  }
}

function plateCount(): number {
  let count = 0;
  for (const sub of subscribers.values()) {
    if (sub.priority === "plate") count++;
  }
  return count;
}

/** Whether one more "plate" subscriber is currently allowed under the
 *  concurrency cap. Callers should check this before ever mounting a canvas
 *  for a mini/plate stage — see the module doc comment. */
export function canSubscribePlate(): boolean {
  return plateCount() < PLATE_CONCURRENCY_CAP;
}

export function subscribe(sub: MotionFrameSubscriber): () => void {
  subscribers.set(sub.id, sub);
  ensureRunning();
  return () => {
    subscribers.delete(sub.id);
    stopIfIdle();
  };
}

/** Test/debug only — current subscriber count without exposing the map. */
export function debugSubscriberCount(): number {
  return subscribers.size;
}

/** Test/debug only — whether the shared ticker is currently running. */
export function debugIsRunning(): boolean {
  return rafId !== null;
}
