/**
 * One global `requestAnimationFrame` ticker, shared by every mounted motion
 * stage (WEBUI_V3_SPEC.md §4.1, §4.4) — not one loop per stage. Stages
 * register/unregister via `subscribe()`; the ticker starts on the first
 * subscriber and stops on the last (nothing spins while nothing is
 * mounted).
 *
 * Nothing here owns a canvas. The `ctx` argument this module threads
 * through `tick()` is a shared placeholder that real subscribers ignore in
 * favour of whatever surface they actually draw to; it exists only so
 * `MotionFrameSubscriber.draw`'s signature matches §4.4 exactly without
 * every call site needing a fake non-null context of its own.
 *
 * Since the Canvas2D stage was deleted
 * (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`) there is
 * exactly ONE subscriber in the app: `lamp3d/renderer.ts` registers once
 * and walks its own view registry inside that tick. So the tiering below no
 * longer decides which stages get a context — one shared `WebGLRenderer`
 * serves every mounted stage, whatever the count. `PLATE_CONCURRENCY_CAP`
 * survives as the *redraw budget* `renderer.ts` passes to `drawSets()`:
 * how many plates animate per frame, not how many contexts exist.
 *
 * `canSubscribePlate()` is therefore test-only at present. It is kept
 * because the property it guards — a bounded number of plate-priority
 * subscribers — is the ticker's own invariant, and a second WebGL-free
 * subscriber (a future sparkline, a meter needle) would need it again.
 */

import type { MotionFrameSubscriber } from "./types";

/** Start conservative; tune empirically against a real iPhone Safari
 *  session with the full dashboard grid visible, per §4.1. Now read as a
 *  redraw budget by `lamp3d/renderer.ts` (see this module's doc comment):
 *  the 4 most recently visible plates animate, the rest hold their last
 *  frame. */
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
