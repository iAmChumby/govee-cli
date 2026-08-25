import assert from "node:assert/strict";
import { test } from "vitest";

import { gradientFill, lerpColorGamma } from "./gradient-tool";

test("lerpColorGamma: midpoint of white->black is 188, not the naive 128", () => {
  // Same gamma-correct EOTF as `device-geometry.ts`'s `downsampleFrame` —
  // linear-light averaging of full white and full black lands well above
  // the naive sRGB-byte midpoint (188 vs 128), which is exactly why the
  // gradient tool and the hardware-preview quantizer are documented to
  // share one color model instead of drifting apart.
  assert.deepEqual(lerpColorGamma([255, 255, 255], [0, 0, 0], 0.5), [188, 188, 188]);
});

test("lerpColorGamma: t=0 and t=1 return the endpoints exactly", () => {
  assert.deepEqual(lerpColorGamma([255, 0, 0], [0, 0, 255], 0), [255, 0, 0]);
  assert.deepEqual(lerpColorGamma([255, 0, 0], [0, 0, 255], 1), [0, 0, 255]);
});

test("lerpColorGamma: t outside [0,1] clamps rather than extrapolating", () => {
  assert.deepEqual(lerpColorGamma([255, 0, 0], [0, 0, 255], -5), [255, 0, 0]);
  assert.deepEqual(lerpColorGamma([255, 0, 0], [0, 0, 255], 5), [0, 0, 255]);
});

test("gradientFill: paints every cell along a straight line, endpoints exact", () => {
  const geometry = { rows: 1, cols: 3, wrapCol: false };
  const canvas = new Uint8ClampedArray(1 * 3 * 3);
  const diffs = gradientFill(canvas, geometry, { row: 0, col: 0 }, { row: 0, col: 2 }, [255, 0, 0], [0, 0, 255]);
  assert.equal(diffs.length, 3);
  assert.deepEqual(diffs.find((d) => d.index === 0)?.to, [255, 0, 0]);
  assert.deepEqual(diffs.find((d) => d.index === 2)?.to, [0, 0, 255]);
});

test("gradientFill: re-applying an identical gradient produces zero diffs", () => {
  const geometry = { rows: 1, cols: 3, wrapCol: false };
  const canvas = new Uint8ClampedArray(1 * 3 * 3);
  const diffs = gradientFill(canvas, geometry, { row: 0, col: 0 }, { row: 0, col: 2 }, [255, 0, 0], [0, 0, 255]);
  // apply the first pass onto the canvas in place, then run the identical gradient again
  for (const d of diffs) {
    canvas[d.index * 3] = d.to[0];
    canvas[d.index * 3 + 1] = d.to[1];
    canvas[d.index * 3 + 2] = d.to[2];
  }
  const second = gradientFill(canvas, geometry, { row: 0, col: 0 }, { row: 0, col: 2 }, [255, 0, 0], [0, 0, 255]);
  assert.equal(second.length, 0);
});

test("gradientFill: cells past either endpoint clamp to a hard edge, not an overshoot", () => {
  const geometry = { rows: 1, cols: 5, wrapCol: false };
  const canvas = new Uint8ClampedArray(1 * 5 * 3);
  // gradient defined only between col 1 and col 3 — col 0 and col 4 sit
  // outside that span on either side and must clamp, not extrapolate.
  const diffs = gradientFill(canvas, geometry, { row: 0, col: 1 }, { row: 0, col: 3 }, [200, 0, 0], [0, 0, 200]);
  assert.deepEqual(diffs.find((d) => d.index === 0)?.to, [200, 0, 0]);
  assert.deepEqual(diffs.find((d) => d.index === 4)?.to, [0, 0, 200]);
});
