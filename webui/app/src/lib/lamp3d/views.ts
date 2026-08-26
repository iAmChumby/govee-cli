/**
 * DOM box <-> WebGL scissor rect maths, and the view registry that decides
 * which mounted stages draw on a given frame.
 *
 * The design (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`)
 * puts every device — the hero and every dashboard plate — on **one**
 * `WebGLRenderer`. That renderer has one drawing buffer; a mounted stage's
 * "canvas" is really just a `scissor`/`viewport` rectangle carved out of it
 * for one draw call. Two coordinate systems have to meet here:
 *
 *   - The DOM reports element boxes in **CSS pixels, top-left origin, y
 *     down** (`getBoundingClientRect()`).
 *   - WebGL's `gl.scissor(x, y, w, h)` and `gl.viewport(...)` take
 *     **device pixels, bottom-left origin, y up**, against the drawing
 *     buffer (`canvas.width`/`canvas.height`, already multiplied by
 *     `devicePixelRatio` — not the CSS size of the canvas element).
 *
 * Everything in this module is pure and DOM-free except the thin
 * `createViewRegistry()` wiring at the bottom, which calls
 * `element.getBoundingClientRect()` and nothing else from `document` — the
 * spec's "pure enough to test" requirement for `views.ts` specifically. A
 * test can hand it a stub object with only that one method and never touch
 * a real DOM.
 */

/** A DOM element's box, CSS pixels, top-left origin, y down — exactly what
 *  `getBoundingClientRect()` reports (the fields this module needs from it). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A `gl.scissor`/`gl.viewport` rectangle: device pixels, bottom-left
 *  origin, y up. */
export interface ScissorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `{ width, height }` meant CSS pixels in `scissorFromRect`/`isOnScreen` but
 * device pixels in `clampScissor`, with nothing in the type system to catch
 * a caller that hands one function the other's size. `CssSize`/`DeviceSize`
 * are nominal via a phantom `__brand` field that never exists at runtime —
 * it exists only so the structural type checker refuses to unify the two,
 * turning the unit mix-up this module used to allow silently into a
 * compile error. Build one with `cssSize()`/`deviceSize()` rather than an
 * object literal, since a literal without `__brand` satisfies neither type.
 */
export interface CssSize {
  readonly __brand: "css-px";
  width: number;
  height: number;
}

/** See `CssSize` — the device-pixel counterpart (`canvas.width`/`.height`,
 *  already multiplied by `devicePixelRatio`). */
export interface DeviceSize {
  readonly __brand: "device-px";
  width: number;
  height: number;
}

export function cssSize(width: number, height: number): CssSize {
  return { __brand: "css-px", width, height };
}

export function deviceSize(width: number, height: number): DeviceSize {
  return { __brand: "device-px", width, height };
}

/**
 * Converts a DOM box into the scissor rect that carves it out of the shared
 * renderer's drawing buffer.
 *
 * `canvas` here is the canvas's **CSS size** (its `clientWidth`/
 * `clientHeight`, the same coordinate space `box` is measured in) — `dpr`
 * is what turns that CSS-space canvas into the device-pixel drawing buffer
 * the scissor rect is expressed against. Callers who already have the
 * drawing buffer's device-pixel size should divide by `dpr` first rather
 * than passing it here, so this function's flip math only ever has to
 * reason about one relationship between the two spaces.
 *
 * The y-flip is the whole trick: a box sitting at the top of the canvas
 * (small CSS `top`) is *far* from the bottom-left scissor origin, so it
 * lands at a *high* device-pixel `y`. `canvas.height * dpr` is the full
 * device-pixel height; subtracting the box's device-pixel bottom edge
 * (`(box.top + box.height) * dpr`) from that gives the scissor rect's `y`.
 */
export function scissorFromRect(box: ScreenRect, canvas: CssSize, dpr: number): ScissorRect {
  const canvasHeightDevicePx = canvas.height * dpr;
  return {
    x: box.left * dpr,
    y: canvasHeightDevicePx - (box.top + box.height) * dpr,
    width: box.width * dpr,
    height: box.height * dpr,
  };
}

/**
 * Whether `box` overlaps the canvas's CSS-space viewport at all — the
 * cheap pre-filter a caller runs before ever computing a scissor rect or
 * touching the renderer. Both `box` and `canvas` are CSS pixels here; no
 * `dpr` is involved because overlap is a ratio-free question.
 *
 * A box that only *touches* an edge (its right edge exactly equal to the
 * canvas's left edge, say) has zero overlapping area and is off-screen —
 * the comparisons below are strict for exactly that reason. A zero-size
 * box (either dimension 0) never overlaps anything, for the same reason:
 * it has no area to share with the canvas.
 */
export function isOnScreen(box: ScreenRect, canvas: CssSize): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return box.left < canvas.width && right > 0 && box.top < canvas.height && bottom > 0;
}

/**
 * Clamps a device-pixel scissor rect to the drawing buffer's device-pixel
 * bounds (`canvas.width`/`canvas.height`, i.e. the *already-scaled*
 * dimensions — not the CSS size `scissorFromRect` takes). A view whose DOM
 * box hangs partly off the canvas — the common case for a dashboard plate
 * scrolled halfway into view — must not ask `gl.scissor` for a rectangle
 * that extends past the buffer; most drivers tolerate it, but nothing
 * downstream should have to rely on that. Returns `null` when the box is
 * fully outside the buffer and nothing is left to draw, matching
 * `isOnScreen`'s "no area, no draw" rule.
 */
export function clampScissor(r: ScissorRect, canvas: DeviceSize): ScissorRect | null {
  const x0 = Math.max(r.x, 0);
  const y0 = Math.max(r.y, 0);
  const x1 = Math.min(r.x + r.width, canvas.width);
  const y1 = Math.min(r.y + r.height, canvas.height);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  return { x: x0, y: y0, width, height };
}

/**
 * The overlap of two CSS-pixel boxes, or `null` when they don't share any
 * area. Used to scissor a view down to the part of it that actually sits
 * inside a clipping ancestor (`ViewRegistration.clipTo`) — a dashboard
 * plate scrolled under the fixed `TopBar` must stop at the ancestor's edge,
 * not paint through it. Zero-area overlap (boxes that only touch) counts
 * as no intersection, the same strict rule `isOnScreen` uses, for the same
 * reason: a touching edge has nothing to draw.
 */
export function intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

// ---------------------------------------------------------------------------
// View registry
// ---------------------------------------------------------------------------

/** What a caller supplies when a stage mounts. `visible`/`box`/
 *  `lastVisibleAt` are the registry's own bookkeeping, computed from this,
 *  never supplied by the caller. */
export interface ViewRegistration {
  id: string;
  element: HTMLElement;
  tier: "hero" | "plate";
  /**
   * The scrolling ancestor this view's canvas must never paint outside of
   * — in this app, the `main.overflow-y-auto` app frame, so a plate
   * scrolled up under the fixed `TopBar` doesn't draw through it. When set,
   * `readBoxes` intersects the view's own box with this element's box
   * (`intersectRect`) and stores the intersection as `StageView.clipBox`,
   * separate from the view's own unclipped `StageView.box` — a view whose
   * clipped box no longer overlaps its clip box at all is treated as not
   * visible, even though its own `getBoundingClientRect()` might still
   * nominally overlap the render canvas.
   */
  clipTo?: HTMLElement;
}

/**
 * One mounted stage, as the registry tracks it. `box`/`clipBox`/`visible`/
 * `lastVisibleAt`/`active`/`activeSince`/`lastActiveAt` are `null`/`false`/
 * `0` until the first `readBoxes()`/`drawSets()` pass measures and schedules
 * the element; a view registered mid-frame simply sits out of every
 * `drawSets()` result until the next measurement, which is the same "not
 * yet known" stance the rest of this codebase takes rather than guessing a
 * box.
 */
export interface StageView {
  id: string;
  element: HTMLElement;
  tier: "hero" | "plate";
  visible: boolean;
  /**
   * This view's own on-screen box, in CSS pixels — the FULL
   * `getBoundingClientRect()` result, never intersected with `clipTo`. A
   * consumer that frames a camera from this box gets a stable aspect ratio
   * and field of view regardless of how much of the view is actually
   * scrolled under a clipping ancestor; see `clipBox` for the rect that
   * limits what actually paints. Previously this field WAS the
   * `clipTo`-intersected box, which fed both the camera framing and the
   * paint clip from one shrinking rect — the bug this split fixes: a stage
   * scrolling under the fixed `TopBar` had its camera aspect and FOV
   * recomputed from the shrinking visible sliver every frame, so the lamp
   * visibly squashed and shrank as it scrolled rather than staying framed
   * and simply being clipped.
   */
  box: ScreenRect | null;
  /**
   * `box` intersected with `clipTo`'s own rect (a copy of `box` when there
   * is no `clipTo`), collapsed to zero area when there is no overlap at
   * all — the same "no area, no draw" convention `isOnScreen`/`clampScissor`
   * use elsewhere in this module. This is what actually limits painted
   * pixels (a scissor rect derives from this, never from `box`), and it is
   * also what `visible` below is computed from: a view scrolled entirely out
   * from under its clipping ancestor must still draw nothing, even though
   * its own unclipped `box` might nominally still overlap the render canvas.
   */
  clipBox: ScreenRect | null;
  lastVisibleAt: number;
  clipTo?: HTMLElement;
  /** Whether this plate held an `active` slot as of the most recent
   *  `drawSets()` call. Registry-owned bookkeeping — see `drawSets`. */
  active: boolean;
  /** `nowMs` at which this plate most recently won an `active` slot.
   *  Registry-owned; drives the fairness rule that decides who yields a
   *  slot first when plates outnumber `plateBudget`. */
  activeSince: number;
  /** `nowMs` of this plate's most recent turn in `active` (`0` if it has
   *  never had one). Registry-owned; drives which waiting plate is owed
   *  the next turn — see `drawSets`. */
  lastActiveAt: number;
}

/** Deterministic id tie-break, used everywhere two views are otherwise
 *  equally ranked. Never `Math.random`, never wall-clock: same inputs,
 *  same order, every call. */
function byId(a: StageView, b: StageView): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * How long a plate may keep an `active` slot before yielding it back to the
 * waiting pool, once at least one other visible plate wants a turn. Matched
 * to the spec's `slow`-tier cadence of about 4fps (~250ms/frame): a waiting
 * plate is guaranteed a shot at a full-rate slot within roughly one of its
 * own slow-tier refresh intervals, rather than being demoted once (as the
 * arrival-recency sort used to do) and left there for the life of the page.
 */
const ROTATION_HOLD_MS = 250;

export interface ViewRegistry {
  /** Adds a view and returns a disposer. Calling the disposer more than
   *  once is safe — the second call is a no-op, matching the unmount-effect
   *  cleanup pattern (`use-lamp-stage.ts`'s effect return) that may run its
   *  cleanup defensively. */
  register(view: ViewRegistration): () => void;
  /**
   * Measures every registered element's `getBoundingClientRect()` against
   * the canvas's current CSS-space size and updates `box`/`clipBox`/
   * `visible` accordingly. `box` is always the FULL element rect, untouched
   * by `clipTo`. When a view has `clipTo` set, `clipBox` is that full box
   * intersected with the clip element's own rect (`intersectRect`); a view
   * pushed entirely outside its clip box gets a `clipBox` of zero area, so
   * `isOnScreen` — and everything downstream, including `visible` — treats
   * it as not visible. A view with no `clipTo` gets `clipBox` equal to `box`.
   *
   * `nowMs` is stamped onto `lastVisibleAt` only on the transition from
   * off-screen (or never-yet-measured) to on-screen — a view that has
   * stayed visible across many calls keeps the timestamp of when it *most
   * recently arrived*. Continuously refreshing it on every call would make
   * every steadily-visible view equally "recent" and erase the arrival
   * order `drawSets` uses to break first-time ties.
   *
   * The reverse transition — on-screen to off-screen — immediately clears
   * `active`: leaving the screen forfeits any draw-budget slot on the spot,
   * rather than leaving a slot nominally held by a view `drawSets` will
   * never see in its visible set again.
   */
  readBoxes(canvas: CssSize, nowMs: number): void;
  /** All registered views, in no particular order. Mainly for tests and
   *  diagnostics — `drawSets` is what render code should call. */
  list(): StageView[];
  /**
   * The redraw budget from the spec's Performance Budget section: the hero
   * always draws; among on-screen plates, up to `plateBudget` of them draw
   * every frame (`active`), and the rest hold their last frame and are
   * returned in `slow` so the caller can refresh them at a slower cadence
   * (about 4fps per the spec). A plate that is off-screen appears in
   * neither array — it does not draw at all, not even slowly.
   *
   * The policy, precisely:
   *
   *   1. **Incumbency is sticky.** A plate already holding an `active` slot
   *      keeps it, unmoved, for as long as it stays visible and no other
   *      visible plate is waiting for a turn. This is what makes a steady
   *      dashboard not flicker between `active` and `slow` from call to
   *      call.
   *   2. **A slot is never held forever under contention.** Once at least
   *      one other visible plate has no slot, an incumbent that has held
   *      its slot for `ROTATION_HOLD_MS` yields it back to the waiting
   *      pool. This is the fix for the starvation bug the old
   *      arrival-recency sort had: that sort re-stamped only the winners'
   *      timestamps, so a newly arrived plate always looked "more recent"
   *      than an incumbent and displaced it permanently — the incumbent's
   *      frozen timestamp could never win a future sort. Nothing here is
   *      timestamp-vs-timestamp; a slot is freed on a hold-time clock and
   *      handed to whoever has waited longest, so every visible plate is
   *      guaranteed a turn.
   *   3. **Waiting plates are served oldest-turn-first.** Among plates
   *      without a slot, the one that has gone longest without an `active`
   *      turn (or has never had one) is promoted first. Ties among plates
   *      that have never had a turn go to whichever arrived at the canvas
   *      most recently, then to `id` — both fully deterministic.
   *   4. **If `plateBudget` itself shrinks** below the number of surviving
   *      incumbents, the incumbents that have held their slot longest give
   *      it up first, the same fairness rule rotation already uses.
   *
   * No `Math.random`, no `Date.now` inside this module — every decision is
   * a pure function of the registry's stored state, `plateBudget`, and the
   * caller-supplied `nowMs`.
   */
  drawSets(plateBudget: number, nowMs: number): { active: StageView[]; slow: StageView[] };
}

export function createViewRegistry(): ViewRegistry {
  const views = new Map<string, StageView>();

  return {
    register(registration: ViewRegistration): () => void {
      const view: StageView = {
        id: registration.id,
        element: registration.element,
        tier: registration.tier,
        visible: false,
        box: null,
        clipBox: null,
        lastVisibleAt: 0,
        clipTo: registration.clipTo,
        active: false,
        activeSince: 0,
        lastActiveAt: 0,
      };
      views.set(registration.id, view);

      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        // Only remove the entry if it is still the one this call
        // registered — guards against a disposer from a stale closure
        // deleting a different view that was re-registered under the same
        // id after this one was already torn down.
        if (views.get(registration.id) === view) {
          views.delete(registration.id);
        }
      };
    },

    readBoxes(canvas: CssSize, nowMs: number): void {
      for (const view of views.values()) {
        const rect = view.element.getBoundingClientRect();
        const box: ScreenRect = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
        // `clipBox` is the paint/visibility rect; `box` above stays the full,
        // unclipped element rect so the camera framing derived from it (see
        // `renderer.ts`'s `computeFrameRects`) never shrinks just because a
        // scrolling ancestor is covering part of the view.
        let clipBox: ScreenRect = box;
        if (view.clipTo) {
          const clipRect = view.clipTo.getBoundingClientRect();
          const intersected = intersectRect(box, {
            left: clipRect.left,
            top: clipRect.top,
            width: clipRect.width,
            height: clipRect.height,
          });
          // No overlap with the clip box: keep the box's position (for
          // diagnostics) but zero its area so `isOnScreen` reports false,
          // the same "no area, no draw" rule the rest of this module uses.
          clipBox = intersected ?? { left: box.left, top: box.top, width: 0, height: 0 };
        }
        const onScreen = isOnScreen(clipBox, canvas);
        view.box = box;
        view.clipBox = clipBox;
        if (onScreen && !view.visible) {
          view.lastVisibleAt = nowMs;
        }
        if (!onScreen && view.visible) {
          view.active = false;
        }
        view.visible = onScreen;
      }
    },

    list(): StageView[] {
      return Array.from(views.values());
    },

    drawSets(plateBudget: number, nowMs: number): { active: StageView[]; slow: StageView[] } {
      const active: StageView[] = [];
      const visiblePlates: StageView[] = [];

      for (const view of views.values()) {
        if (view.tier === "hero") {
          active.push(view);
          continue;
        }
        if (!view.visible) continue; // off-screen: neither list
        visiblePlates.push(view);
      }

      let incumbents = visiblePlates.filter((v) => v.active);
      const candidates = visiblePlates.filter((v) => !v.active);

      // Forced rotation: a plate that has held its slot past the hold
      // window yields it, but only when something is actually waiting —
      // demoting an incumbent with no competitor would just re-promote it
      // one line later for no benefit and would flicker `active` for
      // nothing.
      if (candidates.length > 0) {
        const stillIncumbent: StageView[] = [];
        for (const v of incumbents) {
          if (nowMs - v.activeSince >= ROTATION_HOLD_MS) {
            v.active = false;
            candidates.push(v);
          } else {
            stillIncumbent.push(v);
          }
        }
        incumbents = stillIncumbent;
      }

      // `plateBudget` may itself be smaller than the surviving incumbents
      // (a caller lowering it between calls). Trim with the same fairness
      // rule as the rotation above: whoever has held the slot longest
      // yields first.
      incumbents.sort((a, b) => a.activeSince - b.activeSince || byId(a, b));
      while (incumbents.length > plateBudget) {
        const evicted = incumbents.shift();
        if (!evicted) break;
        evicted.active = false;
        candidates.push(evicted);
      }

      const remainingSlots = Math.max(0, plateBudget - incumbents.length);
      candidates.sort((a, b) => {
        if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt - b.lastActiveAt;
        // Tie — commonly both have never had a turn (`lastActiveAt === 0`).
        // Prefer whichever arrived at the canvas most recently, matching
        // the "most recently visible plates win the budget" rule for a
        // cold start where nothing has taken a turn yet.
        if (a.lastVisibleAt !== b.lastVisibleAt) return b.lastVisibleAt - a.lastVisibleAt;
        return byId(a, b);
      });
      const promoted = candidates.slice(0, remainingSlots);
      const stillWaiting = candidates.slice(remainingSlots);

      for (const v of promoted) {
        v.active = true;
        v.activeSince = nowMs;
      }
      for (const v of incumbents) {
        v.lastActiveAt = nowMs;
      }
      for (const v of promoted) {
        v.lastActiveAt = nowMs;
      }

      active.push(...incumbents, ...promoted);

      return { active, slow: stillWaiting };
    },
  };
}
