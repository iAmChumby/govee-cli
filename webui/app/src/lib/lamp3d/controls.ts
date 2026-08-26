/**
 * Orbit for the hero view only — the design doc's own non-goal list rules
 * out controls on plates ("plates are wrapped in a `<Link>`; a drag would
 * fight navigation"), so `renderer.ts` calls `attachOrbitControls` exactly
 * once per mounted view, and only when that view's tier is `"hero"`.
 *
 * No zoom, no pan: the only thing a drag ever changes is azimuth and a
 * clamped elevation, at a fixed radius from the orbit target. That radius is
 * chosen once, by `renderer.ts`, from the model's own `fitRadius` when the
 * view is framed, and this module never adjusts it.
 *
 * The maths (`clampElevation`, `sphericalOffset`, `shouldClaimGesture`,
 * `dragToAngles`) is pure and unit-tested directly. `attachOrbitControls`
 * itself — real `pointerdown`/`pointermove` listeners on a real DOM element,
 * mutating a real `THREE.PerspectiveCamera` — is not: jsdom has no working
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
 *  scroll-start jitter should never be read as an intentional drag. */
const GESTURE_CLAIM_THRESHOLD_PX = 6;

/**
 * Whether an in-progress pointer drag should be claimed as an orbit gesture
 * rather than left for the page's own vertical scroll — the "only claim the
 * gesture once it is clearly horizontal" rule the design doc asks for.
 * `dx`/`dy` are cumulative travel since the gesture started (not a
 * per-event delta): using the full travel-so-far, rather than one move
 * event's tiny step, is what makes this robust to the natural jitter at the
 * very start of a drag, where a single sample can point either way.
 */
export function shouldClaimGesture(dx: number, dy: number): boolean {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < GESTURE_CLAIM_THRESHOLD_PX) return false;
  return adx > ady;
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
 * Wires pointer-drag rotation onto `camera`, orbiting it around `target` at
 * a fixed `radius`. Sets the camera's starting position immediately (so a
 * hero renders correctly framed before the user ever touches it) and
 * updates it on every claimed drag step thereafter.
 *
 * `element.style.touchAction = "pan-y"` is the actual mechanism behind "must
 * not fight page scroll": it tells the browser to keep handling vertical
 * panning itself, so this code never has to call `preventDefault()` on a
 * touch gesture to stop the page from scrolling out from under a rotate.
 * `shouldClaimGesture` is the complementary half — even with vertical scroll
 * left entirely to the browser, a diagonal swipe should still read as a
 * rotate once its horizontal component clearly dominates.
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
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true;
    claimed = false;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
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
      if (!shouldClaimGesture(dxFromStart, dyFromStart)) return;
      claimed = true;
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is a nice-to-have (keeps receiving move events if
        // the pointer leaves the element mid-drag); its absence or failure
        // in an unusual environment should never break the rotate itself.
      }
      lastX = e.clientX;
      lastY = e.clientY;
    }

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const { dAzimuth, dElevation } = dragToAngles(dx, dy);
    azimuth += dAzimuth;
    elevation = clampElevation(elevation + dElevation);
    applyCamera();
  }

  function endDrag(e: PointerEvent): void {
    if (claimed) {
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        // See onPointerMove's try/catch: capture release failing is not a
        // reason to leave the drag stuck in a "dragging" state.
      }
    }
    dragging = false;
    claimed = false;
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", endDrag);
      element.removeEventListener("pointercancel", endDrag);
      element.style.touchAction = previousTouchAction;
    },
  };
}
