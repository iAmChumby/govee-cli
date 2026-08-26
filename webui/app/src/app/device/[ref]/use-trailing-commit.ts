"use client";

import * as React from "react";

/* ==================================================================
   Coalescing primitives for continuous inputs (Dial, Slider) driving a
   real device over the network. See CLAUDE.md "The request meter, and
   what it may not claim" — every call that reaches `GoveeHTTPv2._request`
   is a real command to a real light, and the cloud publishes no rate
   limit, so the only signal we get for "too many" is a 429. Dragging a
   slider must not turn into a burst of those.

   Each pure `create*` factory below is deliberately framework-free
   (timers only, no React) so it can be exercised by a plain node vitest
   run — `vitest.config.ts` runs every "*.test.ts" file under src/ in a
   `node` environment with no DOM and no React renderer wired up, exactly like
   `use-edge-scroll.ts`'s `computeEdges`. A hook cannot be called outside
   a component render, so testing the *hook* directly is not an option;
   testing the pure core it wraps is. The `use*` hooks after each factory
   are thin, untested-by-necessity wiring: a ref to keep the latest
   callback (props change across renders, the pending timer must not) and
   an unmount effect that discards anything still pending — firing a
   mutation from cleanup would send a command after the component, and
   the user's attention, are already gone.
   ================================================================== */

/**
 * Plain trailing-edge debounce (not a throttle: every call cancels and
 * reschedules the pending timer, so the FIRST call in a burst never
 * fires — only the LAST one does, `delay` ms after the burst goes
 * quiet). This was the whole bug: `control-deck.tsx`'s brightness Dial
 * used to route its `onValueChange` — which fires on every pixel of a
 * drag — straight through one of these with a bare 150ms default, so a
 * three-second drag with a few realistic sub-150ms pauses mid-gesture
 * fired a real cloud request at *each* pause, not once at the end.
 *
 * That default is gone: `delay` is required. An unexamined number
 * quietly reused by every new call site is exactly how the bug happened,
 * so every caller must now import one of this file's named, justified
 * constants (or derive and justify its own) instead of accepting
 * whatever the last person picked.
 *
 * This primitive still has a legitimate job: coalescing a stream that
 * has no real "I'm done" event of its own at all (the native
 * `<input type="color">`'s `input` event fires continuously while its
 * OS-level dialog is open, with nothing resembling a release). It is the
 * wrong tool for Dial/Slider, which now have a real per-gesture commit
 * signal — see `createGestureCommit` below.
 */
export function createTrailingCommit<T>(
  commit: (value: T) => void,
  delay: number,
): { call: (value: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;

  return {
    call(value: T) {
      pending = value;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const v = pending;
        pending = null;
        if (v !== null) commit(v);
      }, delay);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** React wiring for `createTrailingCommit` — see the module doc above. */
export function useTrailingCommit<T>(commit: (value: T) => void, delay: number): (value: T) => void {
  const commitRef = React.useRef(commit);
  commitRef.current = commit;

  const core = React.useRef<ReturnType<typeof createTrailingCommit<T>> | null>(null);
  if (core.current === null) {
    core.current = createTrailingCommit<T>((v) => commitRef.current(v), delay);
  }

  React.useEffect(() => () => core.current?.cancel(), []);

  return React.useCallback((value: T) => core.current?.call(value), []);
}

/* ------------------------------------------------------------------
   Gesture commit — the Dial/Slider fix.

   A drag or a keyboard run has a real "I'm done" moment (pointerup /
   pointercancel for a drag, keyup for a keyboard run), and that moment
   should send *immediately* — a released dial that waits out a timer
   before the light responds reads as broken, not "coalesced". The two
   halves below exist for two different reasons:

   - `trackPointerMove` / `commitPointerRelease`: the release event
     (`commitPointerRelease`) is the entire mechanism for a drag — it
     fires once, synchronously, no timer involved. `trackPointerMove` is
     only a safety net for the case where that event never reaches us at
     all (lost pointer capture, an OS-level interruption); it has to
     survive an *actively moving* drag's own mid-gesture pauses, which is
     the exact thing that made the old 150ms debounce fire early. See
     `POINTER_SAFETY_NET_MS` below for the number.

   - `bufferKeyStep` / `flushKeyRun`: Radix's `Slider` (confirmed by
     reading `@radix-ui/react-slider`'s `onStepKeyDown` — it calls
     `updateValues(nextValue, atIndex, { commit: true })` on *every*
     keydown, including OS auto-repeat) fires its `onValueCommit` once per
     discrete keyboard step, not once per keyboard *interaction*. Holding
     an arrow key down for two seconds is a dozen or more "commits" with a
     dozen or more different values — sending every one of those is a
     smaller-scale repeat of the exact bug this file exists to fix, so
     they get buffered instead and only actually sent when the run ends.
     `flushKeyRun` is the real end-of-run signal (`keyup`, or `blur` if
     focus leaves mid-run); `bufferKeyStep`'s own timer
     (`keyCommitDelayMs`) is only a fallback for callers with no discrete
     end event at all (`Dial`'s scroll-wheel nudge — a fast trackpad
     flick has no "key" to release).
   ================================================================== */

export interface GestureCommit<T> {
  /** Raw drag movement — never sends by itself except via the safety net. */
  trackPointerMove(value: T): void;
  /** The drag's real end. Sends `value` synchronously. */
  commitPointerRelease(value: T): void;
  /** One discrete keyboard/wheel step. Buffers; does not send. */
  bufferKeyStep(value: T): void;
  /** The run's real end (keyup/blur). Sends the buffered value synchronously. */
  flushKeyRun(): void;
  /** Discards anything pending without sending it — call on unmount. */
  dispose(): void;
}

export interface GestureCommitOptions<T> {
  send: (value: T) => void;
  /** See `KEY_COMMIT_COALESCE_MS`'s comment for the number and why. */
  keyCommitDelayMs: number;
  /** See `POINTER_SAFETY_NET_MS`'s comment for the number and why. */
  pointerSafetyNetMs: number;
}

export function createGestureCommit<T>(opts: GestureCommitOptions<T>): GestureCommit<T> {
  let keyTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingKey: T | null = null;
  let pendingPointer: T | null = null;

  const clearKeyTimer = () => {
    if (keyTimer !== null) clearTimeout(keyTimer);
    keyTimer = null;
  };
  const clearPointerTimer = () => {
    if (pointerTimer !== null) clearTimeout(pointerTimer);
    pointerTimer = null;
  };

  return {
    trackPointerMove(value) {
      pendingPointer = value;
      clearPointerTimer();
      pointerTimer = setTimeout(() => {
        pointerTimer = null;
        const v = pendingPointer;
        pendingPointer = null;
        if (v !== null) opts.send(v);
      }, opts.pointerSafetyNetMs);
    },
    commitPointerRelease(value) {
      // The real event beats the safety net it would otherwise race —
      // drop the pending timer so a late pointerup right before it would
      // have fired can never send the same gesture's value twice.
      clearPointerTimer();
      pendingPointer = null;
      opts.send(value);
    },
    bufferKeyStep(value) {
      pendingKey = value;
      clearKeyTimer();
      keyTimer = setTimeout(() => {
        keyTimer = null;
        const v = pendingKey;
        pendingKey = null;
        if (v !== null) opts.send(v);
      }, opts.keyCommitDelayMs);
    },
    flushKeyRun() {
      clearKeyTimer();
      const v = pendingKey;
      pendingKey = null;
      if (v !== null) opts.send(v);
    },
    dispose() {
      clearKeyTimer();
      clearPointerTimer();
      pendingKey = null;
      pendingPointer = null;
    },
  };
}

/** React wiring for `createGestureCommit` — see the module doc above. */
export function useGestureCommit<T>(
  send: (value: T) => void,
  opts: { keyCommitDelayMs: number; pointerSafetyNetMs: number },
): GestureCommit<T> {
  const sendRef = React.useRef(send);
  sendRef.current = send;

  const core = React.useRef<GestureCommit<T> | null>(null);
  if (core.current === null) {
    core.current = createGestureCommit<T>({
      send: (v) => sendRef.current(v),
      keyCommitDelayMs: opts.keyCommitDelayMs,
      pointerSafetyNetMs: opts.pointerSafetyNetMs,
    });
  }

  React.useEffect(() => () => core.current?.dispose(), []);

  return core.current;
}

/**
 * Held-arrow-key auto-repeat and a fast trackpad wheel "flick" both fire
 * discrete steps roughly every 20-50ms (OS-dependent — Windows' fastest
 * key-repeat-rate setting is ~31ms). `bufferKeyStep`'s flush timer only
 * has to bridge that gap, not a pointer drag's own pauses (a drag's real
 * end is `commitPointerRelease`, which never touches this timer), so it
 * can stay short: 300ms is roughly 6-10x the fastest repeat interval —
 * comfortable margin against ever firing mid-run — while still reading
 * as instant to a person who has actually stopped pressing the key.
 */
export const KEY_COMMIT_COALESCE_MS = 300;

/**
 * Safety net for a pointer gesture whose release event never reaches us
 * at all (lost pointer capture, an OS-level interruption). Unlike the
 * keyboard window above, this one has to survive an *actively moving*
 * drag's own mid-gesture pauses — a person dragging a dial for a few
 * seconds routinely pauses past 150ms without having let go, which is
 * exactly what made the old debounce (150ms, fed by every `onValueChange`
 * tick) fire early and is the bug this file exists to fix. 1500ms is
 * longer than any pause made while still actively adjusting a dial; if a
 * pause runs that long the gesture has, for practical purposes, already
 * ended, so firing here reads as correct rather than premature. In the
 * ordinary case `commitPointerRelease` has already sent and cleared this
 * timer well before it would ever fire — it exists for the drag that
 * ends without a clean release, not the drag that just moves slowly.
 */
export const POINTER_SAFETY_NET_MS = 1500;

/**
 * Coalescing window for the native `<input type="color">` — the one input
 * in this console that genuinely has no release event to commit on.
 *
 * The OS colour dialog streams `input` events for as long as it is open:
 * dragging across a colour wheel emits continuously, and closing the
 * dialog fires nothing distinguishable from another change. So this is
 * the one place `createTrailingCommit` is the right tool rather than
 * `createGestureCommit` — there is no gesture boundary to detect, only a
 * stream that goes quiet.
 *
 * 400ms rather than `POINTER_SAFETY_NET_MS`: a colour wheel drag has no
 * competing "the release already sent it" path to fall back on, so this
 * timer is the *only* thing that ever sends. It has to be short enough
 * that picking a colour feels responsive, and long enough to swallow the
 * pauses a person makes while hunting for a shade. 400ms sits above the
 * ~200ms a hand naturally rests mid-hunt and well below the point where
 * the light feels disconnected from the picker.
 */
export const COLOR_DIALOG_COALESCE_MS = 400;
