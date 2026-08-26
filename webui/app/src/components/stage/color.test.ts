/**
 * Tests for `color.ts`'s pure maths, and specifically for `basicHsl` — the
 * "which of colour/temperature is the device actually emitting" rule.
 *
 * The bug it exists to prevent: a lamp sitting at 2000 K reports
 * `colorRgb` as a placeholder white *and* `colorTemperatureK: 2000`. Every
 * derivation path used to read `color` first, so the console painted a flat
 * neutral white slab while the room was visibly amber.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { basicHsl, isPlaceholderWhite, prefersColorTemp, rgbToHsl, kelvinToRgb, WARM_HSL } from "./color";

test("a real colour outranks a temperature reading", () => {
  // Red commanded over RGB: the hardware zeroes the temp, but even a stale
  // one must not repaint a saturated colour.
  assert.deepEqual(basicHsl([255, 0, 0], 2700), rgbToHsl([255, 0, 0]));
  assert.deepEqual(basicHsl([255, 0, 0], null), rgbToHsl([255, 0, 0]));
});

test("a placeholder white yields to the live colour temperature", () => {
  assert.deepEqual(basicHsl([255, 255, 255], 2000), rgbToHsl(kelvinToRgb(2000)));
  assert.notDeepEqual(basicHsl([255, 255, 255], 2000), rgbToHsl([255, 255, 255]));
});

test("white with no temperature stays white", () => {
  assert.deepEqual(basicHsl([255, 255, 255], null), rgbToHsl([255, 255, 255]));
});

test("temperature alone, and neither, keep their existing answers", () => {
  assert.deepEqual(basicHsl(null, 6500), rgbToHsl(kelvinToRgb(6500)));
  assert.deepEqual(basicHsl(null, null), WARM_HSL);
});

test("near-white survives the placeholder test, pastels do not", () => {
  assert.equal(isPlaceholderWhite([255, 255, 255]), true);
  assert.equal(isPlaceholderWhite([250, 252, 255]), true); // firmware rounding
  assert.equal(isPlaceholderWhite([234, 242, 255]), false); // the #EAF2FF swatch
  assert.equal(isPlaceholderWhite([255, 137, 14]), false);
});

test("prefersColorTemp is the predicate the readouts share", () => {
  assert.equal(prefersColorTemp([255, 255, 255], 2000), true);
  assert.equal(prefersColorTemp([255, 255, 255], null), false);
  assert.equal(prefersColorTemp([255, 0, 0], 2000), false);
  assert.equal(prefersColorTemp(null, 2000), true);
  assert.equal(prefersColorTemp(null, null), false);
});
