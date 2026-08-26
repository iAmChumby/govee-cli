/**
 * Tests for `use-trailing-commit.ts`'s pure cores. Both hooks in that file
 * (`useTrailingCommit`, `useGestureCommit`) are React hooks and cannot be
 * called outside a component render — this repo's vitest run is
 * `node`-environment with no DOM/React renderer (see `vitest.config.ts`'s own
 * docblock), the same reason `use-edge-scroll.test.ts` only exercises
 * `computeEdges` rather than the hook that wraps it. `createTrailingCommit`
 * and `createGestureCommit` are the framework-free halves that make this
 * testable at all.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import {
  createGestureCommit,
  createTrailingCommit,
  KEY_COMMIT_COALESCE_MS,
  POINTER_SAFETY_NET_MS,
} from "./use-trailing-commit";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/* --------------------------------------------------- createTrailingCommit */

test("a realistic 3-second drag (60 events, sub-150ms pauses) sends exactly once", () => {
  const sent: number[] = [];
  const debounced = createTrailingCommit<number>((v) => sent.push(v), 300);

  // 60 calls over 3000ms with pauses that vary but never exceed 150ms —
  // the exact shape of the drag that broke the old 150ms-default debounce.
  for (let i = 0; i < 60; i++) {
    debounced.call(i);
    vi.advanceTimersByTime(50 + (i % 3) * 40); // 50, 90, 130ms — all < 150ms, all < the 300ms delay
  }
  // Let the final quiet window elapse.
  vi.advanceTimersByTime(300);

  assert.deepEqual(sent, [59]);
});

test("cancel before the delay elapses drops the pending value (unmount case)", () => {
  const sent: number[] = [];
  const debounced = createTrailingCommit<number>((v) => sent.push(v), 300);

  debounced.call(42);
  vi.advanceTimersByTime(200);
  debounced.cancel();
  vi.advanceTimersByTime(1000);

  assert.deepEqual(sent, []);
});

test("a pause longer than the delay flushes mid-stream, then the stream continues", () => {
  const sent: number[] = [];
  const debounced = createTrailingCommit<number>((v) => sent.push(v), 300);

  debounced.call(1);
  vi.advanceTimersByTime(300); // settles — fires with 1
  debounced.call(2);
  vi.advanceTimersByTime(300); // settles — fires with 2

  assert.deepEqual(sent, [1, 2]);
});

/* ---------------------------------------------------- createGestureCommit */

function makeGesture(sent: number[]) {
  return createGestureCommit<number>({
    send: (v) => sent.push(v),
    keyCommitDelayMs: KEY_COMMIT_COALESCE_MS,
    pointerSafetyNetMs: POINTER_SAFETY_NET_MS,
  });
}

test("commitPointerRelease sends synchronously — no timer advance needed", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.commitPointerRelease(77);

  // Deliberately no vi.advanceTimersByTime call: a release must land
  // before any timer would fire, not "quickly" — "immediate" means
  // synchronous, and this assertion is the difference between the two.
  assert.deepEqual(sent, [77]);
});

test("a settled drag (many pointer moves, then release) sends exactly once, immediately", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  for (let i = 0; i < 60; i++) {
    gesture.trackPointerMove(i);
    vi.advanceTimersByTime(50); // well under the 1500ms pointer safety net
  }
  gesture.commitPointerRelease(59);

  assert.deepEqual(sent, [59]);

  // The safety net that was tracking the drag must not also fire later
  // with a stale value — commitPointerRelease clears it.
  vi.advanceTimersByTime(POINTER_SAFETY_NET_MS + 100);
  assert.deepEqual(sent, [59]);
});

test("a drag that ends without a clean release still lands via the safety net", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.trackPointerMove(10);
  vi.advanceTimersByTime(400);
  gesture.trackPointerMove(20);
  // No commitPointerRelease — simulates a lost pointerup/pointercancel.
  vi.advanceTimersByTime(POINTER_SAFETY_NET_MS);

  assert.deepEqual(sent, [20]);
});

test("the pointer safety net does not fire mid-drag on a realistic pause", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.trackPointerMove(1);
  vi.advanceTimersByTime(400); // a real, but not gesture-ending, pause
  gesture.trackPointerMove(2);
  vi.advanceTimersByTime(400);
  gesture.commitPointerRelease(2);

  assert.deepEqual(sent, [2]);
});

test("a held key (many buffered steps) coalesces into one send after the run settles", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  // OS auto-repeat: roughly every 30ms.
  for (let step = 1; step <= 20; step++) {
    gesture.bufferKeyStep(step);
    vi.advanceTimersByTime(30);
  }
  vi.advanceTimersByTime(KEY_COMMIT_COALESCE_MS);

  assert.deepEqual(sent, [20]);
});

test("flushKeyRun (keyup) ends a run synchronously, without waiting out its timer", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.bufferKeyStep(5);
  gesture.flushKeyRun();

  assert.deepEqual(sent, [5]);

  // The buffer's own fallback timer must not also fire a second time.
  vi.advanceTimersByTime(KEY_COMMIT_COALESCE_MS + 100);
  assert.deepEqual(sent, [5]);
});

test("a single tap (one buffered step, then keyup) is not held back", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.bufferKeyStep(1);
  gesture.flushKeyRun();

  assert.deepEqual(sent, [1]);
});

test("dispose discards a pending key buffer without sending (unmount case)", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.bufferKeyStep(99);
  gesture.dispose();
  vi.advanceTimersByTime(KEY_COMMIT_COALESCE_MS + 1000);

  assert.deepEqual(sent, []);
});

test("dispose discards a pending pointer safety net without sending (unmount case)", () => {
  const sent: number[] = [];
  const gesture = makeGesture(sent);

  gesture.trackPointerMove(5);
  gesture.dispose();
  vi.advanceTimersByTime(POINTER_SAFETY_NET_MS + 1000);

  assert.deepEqual(sent, []);
});
