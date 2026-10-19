/**
 * Tests for `renderer.ts`'s Node-testable surface: `isWebGLAvailable`'s
 * no-DOM fallback, the slow-tier redraw cadence decision
 * (`SLOW_TIER_INTERVAL_MS` / `dueForSlowRedraw`), the pure viewport/scissor
 * math in `computeFrameRects`, and the pure camera-distance math in
 * `cameraFitDistance`.
 *
 * Everything else in `renderer.ts` — actually creating a `WebGLRenderer`,
 * mounting a view, drawing a scissored frame — needs a live GL context and
 * is exercised by the browser verification pass (`scripts/verify_ui.py`),
 * not here. Importing this module in the default Node vitest environment is
 * itself a real assertion, not a workaround: the module's lazy-init
 * discipline means nothing at module scope touches `document` or
 * `WebGLRenderer` (both are only ever referenced inside functions called
 * from `mountLampView`), so simply loading it without a DOM is a genuine
 * exercise of that discipline, not a mock standing in for one.
 */

import { describe, expect, it } from "vitest";
import { cssSize, type ScreenRect } from "./views";
import {
  SLOW_TIER_INTERVAL_MS,
  cameraFitDistance,
  computeFrameRects,
  dueForSlowRedraw,
  planFrameDraws,
  isWebGLAvailable,
} from "./renderer";

describe("isWebGLAvailable", () => {
  it("is false with no DOM (this test's own Node environment) rather than throwing", () => {
    expect(typeof document).toBe("undefined");
    expect(isWebGLAvailable()).toBe(false);
  });

  it("caches its answer — calling it again still returns false without re-probing", () => {
    expect(isWebGLAvailable()).toBe(isWebGLAvailable());
  });
});

describe("dueForSlowRedraw", () => {
  it("is not due immediately after a draw", () => {
    expect(dueForSlowRedraw(1000, 1000)).toBe(false);
    expect(dueForSlowRedraw(1000, 1000 + SLOW_TIER_INTERVAL_MS - 1)).toBe(false);
  });

  it("becomes due exactly at the interval boundary — about 4fps per the design doc", () => {
    expect(dueForSlowRedraw(1000, 1000 + SLOW_TIER_INTERVAL_MS)).toBe(true);
    expect(SLOW_TIER_INTERVAL_MS).toBe(250);
    expect(Math.round(1000 / SLOW_TIER_INTERVAL_MS)).toBe(4);
  });

  it("stays due for any later time, not just the exact boundary", () => {
    expect(dueForSlowRedraw(0, 10_000)).toBe(true);
  });

  it("a view that has never drawn (lastDrawnAtMs = 0) is due as soon as any time has passed", () => {
    expect(dueForSlowRedraw(0, SLOW_TIER_INTERVAL_MS)).toBe(true);
  });
});

describe("computeFrameRects", () => {
  const canvasCss = cssSize(400, 300);

  it("frames the viewport and aspect from the FULL box, and the scissor from the CLIPPED box — the shrink/grow-while-scrolling regression", () => {
    // A 100x100 view scrolled 50px up under a fixed clipping ancestor: only
    // the bottom half is actually visible.
    const box: ScreenRect = { left: 0, top: -50, width: 100, height: 100 };
    const clipBox: ScreenRect = { left: 0, top: 0, width: 100, height: 50 };
    const rects = computeFrameRects(box, clipBox, canvasCss);
    expect(rects).not.toBeNull();
    // Aspect comes from the full box (square), not the clipped sliver
    // (which would be 100/50 = 2) — this is the exact bug: reframing the
    // camera from the shrinking clipped rect squashed the model.
    expect(rects!.aspect).toBe(1);
    // Viewport (what frames the camera) is derived from the full box.
    expect(rects!.viewportW).toBe(100);
    expect(rects!.viewportH).toBe(100);
    // Scissor (what actually limits painted pixels) is derived from the
    // clipped box, and is smaller than the viewport.
    expect(rects!.scissorW).toBe(100);
    expect(rects!.scissorH).toBe(50);
  });

  it("with no clipTo (clipBox === box), viewport and scissor dimensions agree", () => {
    const box: ScreenRect = { left: 10, top: 10, width: 40, height: 20 };
    const rects = computeFrameRects(box, box, canvasCss);
    expect(rects).not.toBeNull();
    expect(rects!.aspect).toBe(2);
    expect(rects!.scissorW).toBe(rects!.viewportW);
    expect(rects!.scissorH).toBe(rects!.viewportH);
  });

  it("clamps the scissor to the drawing buffer even when the viewport (from the full box) hangs off the edge", () => {
    const box: ScreenRect = { left: 350, top: 0, width: 100, height: 50 };
    const clipBox = box; // no clipTo, but the box itself overhangs the canvas's right edge
    const rects = computeFrameRects(box, clipBox, canvasCss);
    expect(rects).not.toBeNull();
    // Viewport is unclamped — still the full (off-canvas) width.
    expect(rects!.viewportW).toBe(100);
    // Scissor is clamped to the 400-wide canvas: only 50px is left of it
    // (left=350, canvas width=400).
    expect(rects!.scissorW).toBe(50);
  });

  it("returns null when the clip box has collapsed to zero area, even though the full box is still valid", () => {
    const box: ScreenRect = { left: 10, top: 10, width: 50, height: 50 };
    const clipBox: ScreenRect = { left: 10, top: 10, width: 0, height: 0 };
    expect(computeFrameRects(box, clipBox, canvasCss)).toBeNull();
  });

  it("returns null when the full box itself has zero area", () => {
    const box: ScreenRect = { left: 10, top: 10, width: 0, height: 50 };
    expect(computeFrameRects(box, box, canvasCss)).toBeNull();
  });
});

describe("cameraFitDistance", () => {
  // A tall-ish body: taller above/below the orbit target than it is wide, so
  // the vertical constraint binds — the H6022 and the H6008 are both this shape.
  const tall = { radiusXZ: 1, halfHeight: 2 };

  it("agrees across every aspect >= 1 for a body whose height binds, since the vertical FOV governs there", () => {
    const base = cameraFitDistance(tall, 1);
    expect(cameraFitDistance(tall, 1.5)).toBeCloseTo(base, 10);
    expect(cameraFitDistance(tall, 4)).toBeCloseTo(base, 10);
    expect(cameraFitDistance(tall, 100)).toBeCloseTo(base, 10);
  });

  it("requires strictly more distance for a portrait box (aspect < 1), where the horizontal FOV becomes the binding constraint", () => {
    const wide = { radiusXZ: 2, halfHeight: 1 };
    const base = cameraFitDistance(wide, 1);
    expect(cameraFitDistance(wide, 0.5)).toBeGreaterThan(base);
    expect(cameraFitDistance(wide, 0.1)).toBeGreaterThan(cameraFitDistance(wide, 0.5));
  });

  it("scales with the body's own size", () => {
    const small = cameraFitDistance({ radiusXZ: 1, halfHeight: 2 }, 1);
    const large = cameraFitDistance({ radiusXZ: 2, halfHeight: 4 }, 1);
    expect(large).toBeGreaterThan(small);
  });

  it("frames a WIDE body closer than the enclosing-sphere formula it replaces — the H6056 regression", () => {
    // The pair of light bars is much wider than it is tall. A sphere fit is
    // driven by the largest dimension in any direction, so it treated that
    // body as though it were as tall as it is wide and pushed the camera back
    // far enough that the bars filled about half the frame's height. This
    // asserts the property that fixes it: for a landscape box, a body that is
    // wide-and-short must be framed CLOSER than one that is tall-and-narrow
    // with the same enclosing sphere.
    const enclosing = Math.hypot(2, 1);
    const wideShort = { radiusXZ: 2, halfHeight: 1 };
    const tallNarrow = { radiusXZ: 1, halfHeight: 2 };
    // Same enclosing sphere radius for both, by construction.
    expect(Math.hypot(wideShort.radiusXZ, wideShort.halfHeight)).toBeCloseTo(enclosing, 10);
    expect(Math.hypot(tallNarrow.radiusXZ, tallNarrow.halfHeight)).toBeCloseTo(enclosing, 10);
    // A sphere fit would return the identical distance for both. The box fit
    // must not.
    expect(cameraFitDistance(wideShort, 1.3)).toBeLessThan(cameraFitDistance(tallNarrow, 1.3));
  });

  it("clears the body's own near side, not just its axis", () => {
    // The closest point of the body sits `radiusXZ` nearer the camera than the
    // orbit axis does. A distance measured to the axis alone lets that near
    // edge push out of frame, so the returned distance must always exceed it.
    const body = { radiusXZ: 3, halfHeight: 0.001 };
    expect(cameraFitDistance(body, 1)).toBeGreaterThan(body.radiusXZ);
  });
});

describe("planFrameDraws", () => {
  // The regression this guards: the redraw budget used to decide *presence*,
  // not just animation rate. `renderFrame` skipped a slow-tier view entirely
  // until its cadence came due, on the premise (stated in driver.ts) that
  // "the rest hold their last frame". That premise is false here — the shared
  // canvas is created without `preserveDrawingBuffer`, so the drawing buffer
  // is cleared after every composite and a view that isn't drawn this frame
  // is simply absent from it. With exactly `PLATE_CONCURRENCY_CAP` visible
  // plates the `slow` set was always empty and nothing showed; the fifth
  // device put a plate in `slow` and it visibly blinked ~4x/second.
  const due = () => true;
  const notDue = () => false;

  it("draws every visible view, whichever side of the budget it fell on", () => {
    const plan = planFrameDraws(["hero", "a"], ["b", "c"], notDue);
    expect(plan.map((s) => s.view)).toEqual(["hero", "a", "b", "c"]);
  });

  it("recomputes the LED field for budgeted views", () => {
    const plan = planFrameDraws(["a"], [], notDue);
    expect(plan).toEqual([{ view: "a", recomputeField: true }]);
  });

  it("still draws a slow view that is not due, without recomputing its field", () => {
    // The whole point of the fix: presence every frame, motion at the slow
    // cadence. Dropping the draw is what made the lamp blink.
    const plan = planFrameDraws([], ["b"], notDue);
    expect(plan).toEqual([{ view: "b", recomputeField: false }]);
  });

  it("recomputes a slow view's field once its cadence comes due", () => {
    const plan = planFrameDraws([], ["b"], due);
    expect(plan).toEqual([{ view: "b", recomputeField: true }]);
  });

  it("consults the cadence per view, not once for the whole slow set", () => {
    const plan = planFrameDraws([], ["b", "c"], (v) => v === "c");
    expect(plan).toEqual([
      { view: "b", recomputeField: false },
      { view: "c", recomputeField: true },
    ]);
  });

  it("emits nothing when no view is visible", () => {
    expect(planFrameDraws([], [], due)).toEqual([]);
  });
});
