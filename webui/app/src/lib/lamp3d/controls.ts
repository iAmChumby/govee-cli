/**
 * Orbit for the hero view only — the design doc's own non-goal list rules
 * out controls on plates ("plates are wrapped in a `<Link>`; a drag would
 * fight navigation"), so `renderer.ts` calls `attachOrbitControls` exactly
 * once per mounted view, and only when that view's tier is `"hero"`.
 *
 * No zoom, no pan: the only thing a drag (or an arrow key, or coasting
 * inertia) ever changes is azimuth and a clamped elevation, at a fixed
 * radius from the orbit target. That radius is chosen once, by
 * `renderer.ts`, from the model's own `fitRadius` when the view is framed,
 * and this module never adjusts it.
 *
 * Root cause of "the lamp cannot be rotated at all, on any device": this
 * module was never the problem. `renderer.ts` passes `attachOrbitControls`
 * the exact DOM element `LampStage.tsx` mounts as
 * `<div ... className="pointer-events-none absolute inset-0" />`.
 * `pointer-events: none` means the browser never dispatches `pointerdown`/
 * `pointermove`/`pointerup` to that element at all — not "the handlers ran
 * and did nothing", but "the handlers were never invoked", on desktop and
 * mobile alike. The fix is entirely in `LampStage.tsx` (give the hero's
 * mount point `pointer-events: auto` instead, mini plates stay inert); this
 * module's own gesture rules were already correct for the case that never
 * got a chance to run.
 *
 * The maths (`clampElevation`, `sphericalOffset`, `shouldClaimGesture`,
 * `dragToAngles`, `decayAngularVelocity`) is pure and unit-tested directly.
 * `attachOrbitControls` itself — real `pointerdown`/`pointermove`/`keydown`
 * listeners on a real DOM element, mutating a real `THREE.PerspectiveCamera`,
 * plus a `requestAnimationFrame` coast — is not: jsdom has no working
 * `PointerEvent` implementation to drive it with, and simulating one by
 * hand-assembling a plain `Event` with `clientX`/`clientY` bolted on would
 * be exercising a fake substitute for the browser's own event dispatch
 * rather than this module's real behaviour. That end-to-end path is covered
 * by the browser verification pass (`scripts/verify_ui.py`), not vitest.
 */

import type { PerspectiveCamera, Vector3 } from "three";

/**
 * Elevation is measured up from the horizontal plane through the orbit
 * target (0 = level with the target, `PI / 2` = directly overhead).
 *
 * Every model's target sits at a positive height above the ground plane at
 * y = 0 (`renderer.ts` frames the camera at roughly the model's mid-height —
 * see its `TARGET_HEIGHT_FRACTION`), so keeping elevation positive keeps the
 * camera's own absolute height above the target's height, which is itself
 * above the ground — the camera can never dip to or below the ground plane
 * without this module needing to know the ground's position at all.
 *
 * `MAX_ELEVATION` stops short of `PI / 2` so the camera never reaches
 * straight overhead, where `Camera.lookAt`'s up-vector becomes degenerate
 * (the look direction and the default up vector go parallel) and the
 * rotation snaps rather than orbiting smoothly through the last few degrees.
 */
export const MIN_ELEVATION = 0.12;
export const MAX_ELEVATION = 1.45;

export function clampElevation(elevation: number): number {
  if (elevation < MIN_ELEVATION) return MIN_ELEVATION;
  if (elevation > MAX_ELEVATION) return MAX_ELEVATION;
  return elevation;
}

/**
 * Spherical-to-Cartesian offset from an orbit target: `radius` away, at
 * `azimuth` around the vertical (Y) axis and `elevation` up from level. Pure
 * so `renderer.ts` can use the identical formula to place the camera's
 * *initial* position (before any drag has happened) as this module uses for
 * every subsequent frame.
 */
export function sphericalOffset(azimuth: number, elevation: number, radius: number): readonly [number, number, number] {
  const cosEl = Math.cos(elevation);
  return [radius * cosEl * Math.sin(azimuth), radius * Math.sin(elevation), radius * cosEl * Math.cos(azimuth)];
}

/** Radians of rotation per CSS pixel of drag — tuned so a full turn takes
 *  roughly one phone-width swipe, not a fixed "degrees per drag" constant
 *  that would feel different on a small vs. large hero card. */
const ROTATE_SPEED = 0.0055;

/** Pixel-space drag deltas turn into azimuth/elevation deltas through one
 *  formula, so mouse and touch handlers in `attachOrbitControls` (both
 *  routed through the same pointer-event listeners) can never apply a
 *  slightly different mapping to one input type than the other. Elevation's
 *  sign is inverted relative to azimuth's: dragging *up* (negative `dy`)
 *  should tilt the camera *up* (positive elevation), matching how a
 *  physical object feels like it rotates toward the viewer's drag. */
export function dragToAngles(dx: number, dy: number): { dAzimuth: number; dElevation: number } {
  return { dAzimuth: -dx * ROTATE_SPEED, dElevation: -dy * ROTATE_SPEED };
}

/** Minimum cumulative drag distance, in CSS pixels, before a gesture is
 *  eligible to be claimed as a rotate at all — below this a tap or a
 *  scroll-start jitter should never be read as an intentional drag. Shared
 *  by both branches of `shouldClaimGesture`: touch measures it against the
 *  horizontal component alone (see that function), mouse/pen against the
 *  full drag magnitude, but it is the same "did the pointer actually move"
 *  jitter floor either way. */
const GESTURE_CLAIM_THRESHOLD_PX = 6;

/** The three values `PointerEvent.pointerType` actually takes. Passed in
 *  explicitly rather than read from an event inside the pure predicate
 *  below, so the predicate itself stays a plain function of numbers and
 *  stays unit-testable without a DOM. */
export type PointerInputKind = "mouse" | "pen" | "touch";

/**
 * Whether an in-progress pointer drag should be claimed as an orbit gesture
 * rather than left for the page's own vertical scroll.
 *
 * The rule genuinely differs by input kind, which is why `pointerType` is a
 * parameter rather than something layered on afterward:
 *
 * - **touch**: the page's vertical scroll is a real competing gesture for
 *   the same finger, so a drag is only claimed once its horizontal
 *   component clearly *dominates* the vertical one — a mostly-vertical
 *   swipe is left alone to scroll the page, per the design doc's "only
 *   claim the gesture once it is clearly horizontal" rule.
 * - **mouse / pen**: nothing on the page competes for a mouse-drag the way
 *   scroll competes for a touch-drag — there is no gesture to lose to.
 *   Applying the touch rule here silently ate every mouse drag whose
 *   dominant component was vertical: a user dragging straight up to tilt
 *   the camera got no response at all, because `adx > ady` was false for a
 *   vertical-dominant drag regardless of pointer type. Mouse/pen instead
 *   claim as soon as the drag clears the same small jitter threshold, in
 *   any direction.
 *
 * `dx`/`dy` are cumulative travel since the gesture started (not a
 * per-event delta): using the full travel-so-far, rather than one move
 * event's tiny step, is what makes this robust to the natural jitter at the
 * very start of a drag, where a single sample can point either way.
 */
export function shouldClaimGesture(dx: number, dy: number, pointerType: PointerInputKind): boolean {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (pointerType === "touch") {
    if (adx < GESTURE_CLAIM_THRESHOLD_PX) return false;
    return adx > ady;
  }
  return Math.hypot(dx, dy) >= GESTURE_CLAIM_THRESHOLD_PX;
}

/**
 * Radians of angular velocity per second an orbit gesture retains after
 * `dtSeconds` of coasting, once the pointer has lifted — the "spin briefly
 * and settle, not stop dead" rule. Exponential decay by half-life rather
 * than a linear ramp-down: a linear decay's rate of change is a visible
 * kink at the moment the finger lifts (full speed one frame, then an
 * abrupt slope the next), where exponential decay is continuous with the
 * velocity the drag was already producing.
 *
 * `INERTIA_HALF_LIFE_SECONDS = 0.35` was chosen for "the lamp keeps turning
 * for a beat, not for seconds" — a flick that ends around 3 rad/s (roughly
 * what a fast phone-width swipe produces through `ROTATE_SPEED`) drops
 * below the stop threshold in a bit over a second, which reads as a settle
 * rather than either a dead stop or a lazy Susan that spins for a while.
 *
 * `INERTIA_STOP_THRESHOLD_RAD_PER_S` snaps the tail to exactly zero once
 * decay has made it imperceptible (~1.1 degrees/sec) rather than running an
 * inertia loop indefinitely on floating-point dust that never quite reaches
 * zero under pure exponential decay.
 */
export const INERTIA_HALF_LIFE_SECONDS = 0.35;
export const INERTIA_STOP_THRESHOLD_RAD_PER_S = 0.02;

export function decayAngularVelocity(velocityRadPerSecond: number, dtSeconds: number): number {
  if (dtSeconds <= 0) return velocityRadPerSecond;
  const decayed = velocityRadPerSecond * Math.pow(0.5, dtSeconds / INERTIA_HALF_LIFE_SECONDS);
  return Math.abs(decayed) < INERTIA_STOP_THRESHOLD_RAD_PER_S ? 0 : decayed;
}

/** How much of a fresh instantaneous velocity sample (this move event's own
 *  distance/time) replaces the running estimate on each `pointermove`. A
 *  raw instantaneous sample is noisy — two move events a millisecond apart
 *  produce wildly different `dt`s — so the release velocity that seeds
 *  inertia is a smoothed running estimate, not the very last sample alone,
 *  which could be a jittery near-zero right as the finger lifts. */
const VELOCITY_SMOOTHING = 0.35;

/** Radians per arrow-key press — roughly what a 15px mouse drag produces
 *  through `ROTATE_SPEED` (`15 * 0.0055 ≈ 0.0825`), so one key press reads
 *  as "a small nudge", consistent with how small a drag has to be to
 *  produce a similar step. */
const KEYBOARD_STEP_RADIANS = 0.08;

/** Local copy of the reduced-motion check `renderer.ts` already makes
 *  internally (its own `prefersReducedMotion`) and `theme-toggle.tsx` makes
 *  for an unrelated UI choice. Not imported from `renderer.ts`: that module
 *  imports `attachOrbitControls` from *this* one, so importing the check
 *  back from there would create a cycle for the sake of one three-line
 *  media-query read. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface OrbitHandle {
  dispose(): void;
}

export interface AttachOrbitControlsOptions {
  element: HTMLElement;
  camera: PerspectiveCamera;
  target: Vector3;
  /** Fixed distance from `target` to the camera — never changed by this
   *  module (no zoom). */
  radius: number;
  initialAzimuth?: number;
  initialElevation?: number;
}

/**
 * Wires pointer-drag rotation, arrow-key rotation, and post-release inertia
 * onto `camera`, orbiting it around `target` at a fixed `radius`. Sets the
 * camera's starting position immediately (so a hero renders correctly
 * framed before the user ever touches it) and updates it on every claimed
 * drag step, keyboard nudge, and inertia tick thereafter.
 *
 * `element.style.touchAction = "pan-y"` is the resting mechanism behind
 * "must not fight page scroll": it tells the browser to keep handling
 * vertical panning itself while a gesture is still undecided, so an
 * unclaimed touch drag never needs `preventDefault()` to let the page
 * scroll. Once a touch drag IS claimed as a rotate, `onPointerMove` below
 * switches this to `"none"` for the rest of that one drag (see its own
 * comment) — a claimed rotate needs to be able to tilt (move the finger
 * vertically) without the page scrolling out from under it, which a
 * standing `pan-y` would otherwise still allow. `shouldClaimGesture` is the
 * other half of the touch story — a diagonal swipe still reads as a rotate
 * once its horizontal component clearly dominates.
 *
 * Caller contract (`LampStage.tsx`, `use-lamp-stage.ts`): `element` must
 * already have `pointer-events: auto` and, for keyboard access, a
 * `tabIndex` and an accessible name — this module only adds listeners, it
 * never touches `pointer-events` or ARIA attributes itself, since those are
 * markup decisions that belong with the element's own owner.
 */
export function attachOrbitControls(opts: AttachOrbitControlsOptions): OrbitHandle {
  const { element, camera, target, radius } = opts;
  let azimuth = opts.initialAzimuth ?? 0;
  let elevation = clampElevation(opts.initialElevation ?? 0.35);

  function applyCamera(): void {
    const [ox, oy, oz] = sphericalOffset(azimuth, elevation, radius);
    camera.position.set(target.x + ox, target.y + oy, target.z + oz);
    camera.lookAt(target);
  }
  applyCamera();

  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = "pan-y";

  let dragging = false;
  let claimed = false;
  let activePointerType: PointerInputKind = "mouse";
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastMoveTime = 0;

  // Coasting state. `velocityAzimuth`/`velocityElevation` are a smoothed
  // running estimate of the drag's own angular speed (rad/s), updated on
  // every claimed `pointermove` and consumed by `inertiaStep` after release.
  let velocityAzimuth = 0;
  let velocityElevation = 0;
  let inertiaFrame: number | null = null;
  let lastInertiaTime = 0;

  function stopInertia(): void {
    if (inertiaFrame !== null) {
      cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    }
  }

  function inertiaStep(now: number): void {
    const dt = (now - lastInertiaTime) / 1000;
    lastInertiaTime = now;
    velocityAzimuth = decayAngularVelocity(velocityAzimuth, dt);
    velocityElevation = decayAngularVelocity(velocityElevation, dt);
    if (velocityAzimuth === 0 && velocityElevation === 0) {
      inertiaFrame = null;
      return;
    }
    azimuth += velocityAzimuth * dt;
    elevation = clampElevation(elevation + velocityElevation * dt);
    applyCamera();
    inertiaFrame = requestAnimationFrame(inertiaStep);
  }

  // Self-contained `requestAnimationFrame` loop, started only for the brief
  // coast after a release and cancelled well before it would run
  // indefinitely (see `decayAngularVelocity`'s stop threshold). This is a
  // deliberate exception to "one `requestAnimationFrame` for the whole app"
  // (`driver.ts`): `OrbitHandle` exposes no per-frame hook `renderer.ts`
  // already calls every tick, and reaching one would mean editing
  // `renderer.ts`, which is out of scope for this change. Flagging it here
  // rather than hiding it: a future pass that gives `OrbitHandle` a
  // `tick(dt)` method `renderer.ts`'s own draw loop calls could fold this
  // into the shared ticker and delete this rAF entirely.
  function startInertia(): void {
    if (prefersReducedMotion()) return;
    if (Math.hypot(velocityAzimuth, velocityElevation) < INERTIA_STOP_THRESHOLD_RAD_PER_S) return;
    stopInertia();
    lastInertiaTime = typeof performance !== "undefined" ? performance.now() : Date.now();
    inertiaFrame = requestAnimationFrame(inertiaStep);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopInertia();
    velocityAzimuth = 0;
    velocityElevation = 0;
    activePointerType = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
    dragging = true;
    claimed = false;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;

    if (!claimed) {
      // Measure from the gesture's start, not the last sample: see
      // `shouldClaimGesture`'s doc comment for why cumulative travel is the
      // right signal here. `lastX`/`lastY` deliberately stay pinned to the
      // start position until the gesture is claimed.
      const dxFromStart = e.clientX - startX;
      const dyFromStart = e.clientY - startY;
      if (!shouldClaimGesture(dxFromStart, dyFromStart, activePointerType)) return;
      claimed = true;
      if (activePointerType === "touch") {
        // Switch from the resting `pan-y` to `none` for the rest of THIS
        // drag: a claimed rotate must be able to tilt the camera (a
        // vertical finger movement) without the browser also scrolling the
        // page underneath it. Reverted to `pan-y` in `endDrag` so the very
        // next tap-and-swipe on this element is free to scroll again if it
        // never gets claimed. Not independently browser-verified (no
        // browser in this environment) — some engines only fully honour a
        // `touch-action` change if it lands before the compositor thread
        // has committed to a scroll for this touch sequence, which is why
        // `onPointerMove` also calls `preventDefault()` below once claimed,
        // as a second, independent mechanism for the same goal.
        element.style.touchAction = "none";
      }
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is a nice-to-have (keeps receiving move events if
        // the pointer leaves the element mid-drag); its absence or failure
        // in an unusual environment should never break the rotate itself.
      }
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveTime = typeof performance !== "undefined" ? performance.now() : Date.now();
    }

    if (activePointerType === "touch") {
      // Belt-and-suspenders alongside the `touch-action: none` switch above
      // — see that branch's comment for why both exist.
      e.preventDefault();
    }

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = Math.max((now - lastMoveTime) / 1000, 1 / 1000);
    lastMoveTime = now;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const { dAzimuth, dElevation } = dragToAngles(dx, dy);
    azimuth += dAzimuth;
    elevation = clampElevation(elevation + dElevation);
    applyCamera();

    // Smoothed running estimate of release velocity — see the field
    // comments above `velocityAzimuth`'s declaration for why this is an EMA
    // rather than the raw instantaneous sample.
    velocityAzimuth = velocityAzimuth + (dAzimuth / dt - velocityAzimuth) * VELOCITY_SMOOTHING;
    velocityElevation = velocityElevation + (dElevation / dt - velocityElevation) * VELOCITY_SMOOTHING;
  }

  function endDrag(e: PointerEvent): void {
    if (claimed) {
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        // See onPointerMove's try/catch: capture release failing is not a
        // reason to leave the drag stuck in a "dragging" state.
      }
      if (activePointerType === "touch") {
        // Always restore the resting value here — covers both the normal
        // `pointerup` end of a claimed drag and the abnormal
        // `pointercancel` case (e.g. the OS interrupts the gesture with a
        // system swipe), so this element can never get stuck at
        // `touch-action: none` and silently eat every future scroll.
        element.style.touchAction = "pan-y";
      }
      startInertia();
    }
    dragging = false;
    claimed = false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
        azimuth -= KEYBOARD_STEP_RADIANS;
        break;
      case "ArrowRight":
        azimuth += KEYBOARD_STEP_RADIANS;
        break;
      case "ArrowUp":
        elevation = clampElevation(elevation + KEYBOARD_STEP_RADIANS);
        break;
      case "ArrowDown":
        elevation = clampElevation(elevation - KEYBOARD_STEP_RADIANS);
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    // Arrow keys also scroll the page by default; a focused rotate control
    // claims them the same way a claimed drag claims the pointer.
    e.preventDefault();
    stopInertia();
    applyCamera();
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);
  element.addEventListener("keydown", onKeyDown);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopInertia();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", endDrag);
      element.removeEventListener("pointercancel", endDrag);
      element.removeEventListener("keydown", onKeyDown);
      // Restored unconditionally on dispose regardless of whether a drag
      // was mid-flight (covers the same "never leave it at `none`" concern
      // as `endDrag`'s own restore, for the unmount-during-drag case).
      element.style.touchAction = previousTouchAction;
    },
  };
}
