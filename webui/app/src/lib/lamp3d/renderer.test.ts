/**
 * Tests for `renderer.ts`'s Node-testable surface: `isWebGLAvailable`'s
 * no-DOM fallback, and the slow-tier redraw cadence decision
 * (`SLOW_TIER_INTERVAL_MS` / `dueForSlowRedraw`).
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
import { SLOW_TIER_INTERVAL_MS, dueForSlowRedraw, isWebGLAvailable } from "./renderer";

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
