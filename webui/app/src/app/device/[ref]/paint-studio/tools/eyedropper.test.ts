import assert from "node:assert/strict";
import { test } from "vitest";

import { rgbToHex, sampleColor } from "./eyedropper";

test("sampleColor: reads the exact cell addressed by (row, col)", () => {
  const geometry = { rows: 1, cols: 2, wrapCol: false };
  const canvas = new Uint8ClampedArray(1 * 2 * 3);
  canvas[3] = 138;
  canvas[4] = 92;
  canvas[5] = 255;
  assert.deepEqual(sampleColor(canvas, geometry, 0, 0), [0, 0, 0]);
  assert.deepEqual(sampleColor(canvas, geometry, 0, 1), [138, 92, 255]);
});

test("rgbToHex: round-trips a known color exactly", () => {
  assert.equal(rgbToHex([138, 92, 255]), "#8A5CFF");
  assert.equal(rgbToHex([0, 0, 0]), "#000000");
  assert.equal(rgbToHex([255, 255, 255]), "#FFFFFF");
});

test("rgbToHex: clamps out-of-range channel values instead of producing invalid hex", () => {
  assert.equal(rgbToHex([300, -10, 128]), "#FF0080");
});
