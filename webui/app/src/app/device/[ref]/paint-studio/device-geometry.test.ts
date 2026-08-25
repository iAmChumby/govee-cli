/**
 * Tests for `device-geometry.ts` — WEBUI_V3_SPEC.md §5.2's acceptance
 * definition: "unit-test `downsampleFrame` against a hand-computed
 * expected array." Every expected value below was independently computed
 * (Python re-implementation of the same sRGB EOTF, `math.floor(x+0.5)` for
 * JS `Math.round` parity) and cross-checked against this exact module.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyMotion,
  applySegmentPermutation,
  buildEffectSegments,
  defaultBoundaries,
  downsampleFrame,
  frameCountFor,
  ledIndex,
  segmentBoundaries,
  totalLeds,
} from "./device-geometry";

test("defaultBoundaries splits 132 LEDs into 15 runs of 8-9, per §5.2's pseudocode", () => {
  const b = defaultBoundaries(132, 15);
  assert.deepEqual(b, [0, 8, 17, 26, 35, 44, 52, 61, 70, 79, 88, 96, 105, 114, 123, 132]);
  // every run covers 8 or 9 LEDs, and the runs partition the full range
  for (let i = 0; i < 15; i++) {
    const width = b[i + 1] - b[i];
    assert.ok(width === 8 || width === 9);
  }
});

test("downsampleFrame: uniform segments round-trip their exact color", () => {
  const geometry = { rows: 11, cols: 12, wrapCol: true };
  const total = totalLeds(geometry);
  const boundaries = defaultBoundaries(total, 15);
  const canvas = new Uint8ClampedArray(total * 3);
  // segment 2 covers LEDs 17..25 (9 LEDs) — paint every one identically.
  for (let led = boundaries[2]; led < boundaries[3]; led++) {
    canvas[led * 3] = 100;
    canvas[led * 3 + 1] = 150;
    canvas[led * 3 + 2] = 200;
  }
  const result = downsampleFrame(canvas, boundaries);
  assert.deepEqual(result[2], [100, 150, 200]);
});

test("downsampleFrame: mixed white/black averages gamma-correctly, not to the naive midpoint", () => {
  // §5.2: "avoids the muddy midpoint problem naive sRGB averaging
  // produces." Segment 1 covers 9 LEDs (boundaries[1]=8, boundaries[2]=17):
  // 4 pure white + 5 pure black. Naive sRGB average = 4*255/9 ≈ 113 — a
  // dim gray. Gamma-correct (average in linear light, then re-encode)
  // gives 178, meaningfully brighter, because linear-light averaging
  // weights the white LEDs' actual emitted energy rather than their
  // encoded byte value.
  const geometry = { rows: 11, cols: 12, wrapCol: true };
  const total = totalLeds(geometry);
  const boundaries = defaultBoundaries(total, 15);
  const canvas = new Uint8ClampedArray(total * 3);
  let i = 0;
  for (let led = boundaries[1]; led < boundaries[2]; led++) {
    const on = i < 4;
    canvas[led * 3] = on ? 255 : 0;
    canvas[led * 3 + 1] = on ? 255 : 0;
    canvas[led * 3 + 2] = on ? 255 : 0;
    i++;
  }
  const result = downsampleFrame(canvas, boundaries);
  assert.deepEqual(result[1], [178, 178, 178]);
  assert.notEqual(result[1][0], Math.round((4 * 255) / 9)); // rules out a naive-average implementation
});

test("downsampleFrame: full 15-segment hand-computed array (§5.2's exact acceptance case)", () => {
  const geometry = { rows: 11, cols: 12, wrapCol: true };
  const total = totalLeds(geometry);
  const boundaries = defaultBoundaries(total, 15);
  const canvas = new Uint8ClampedArray(total * 3);
  for (let led = boundaries[0]; led < boundaries[1]; led++) {
    canvas[led * 3] = 255; // segment 0: pure red
  }
  let i = 0;
  for (let led = boundaries[1]; led < boundaries[2]; led++) {
    if (i < 4) {
      canvas[led * 3] = 255;
      canvas[led * 3 + 1] = 255;
      canvas[led * 3 + 2] = 255;
    }
    i++;
  }
  for (let led = boundaries[2]; led < boundaries[3]; led++) {
    canvas[led * 3] = 100;
    canvas[led * 3 + 1] = 150;
    canvas[led * 3 + 2] = 200;
  }
  // segments 3-14 stay unpainted (black) — every LED already 0.

  const expected = [
    [255, 0, 0],
    [178, 178, 178],
    [100, 150, 200],
    ...Array.from({ length: 12 }, () => [0, 0, 0]),
  ];
  assert.deepEqual(downsampleFrame(canvas, boundaries), expected);
});

test("segmentBoundaries falls back to the default hypothesis when no calibration is saved", () => {
  assert.deepEqual(segmentBoundaries(132, 15, null), defaultBoundaries(132, 15));
  assert.deepEqual(segmentBoundaries(132, 15, { boundaries: null, permutation: null }), defaultBoundaries(132, 15));
});

test("segmentBoundaries substitutes a calibrated array only when its shape matches segmentCount+1", () => {
  const calibrated = [0, 9, 18, 26, 35, 44, 53, 61, 70, 79, 88, 96, 105, 114, 123, 132];
  assert.deepEqual(segmentBoundaries(132, 15, { boundaries: calibrated, permutation: null }), calibrated);
  // wrong length (e.g. calibrated for a different segment count) is rejected, not silently truncated
  assert.deepEqual(
    segmentBoundaries(132, 15, { boundaries: [0, 66, 132], permutation: null }),
    defaultBoundaries(132, 15),
  );
});

test("applySegmentPermutation: reindexes boundary-group colors onto calibrated physical segment ids", () => {
  // boundary-group 0's color (red) was, per this calibration, actually lit
  // by physical segment 2 — permutation[0]=2 means "what downsampleFrame
  // computed for position 0 belongs at output index 2."
  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];
  const permutation = [2, 0, 1];
  const result = applySegmentPermutation(colors, permutation);
  assert.deepEqual(result[2], [255, 0, 0]);
  assert.deepEqual(result[0], [0, 255, 0]);
  assert.deepEqual(result[1], [0, 0, 255]);
});

test("applySegmentPermutation: a missing or mismatched-length permutation is the identity (honest default)", () => {
  const colors: [number, number, number][] = [
    [1, 1, 1],
    [2, 2, 2],
  ];
  assert.deepEqual(applySegmentPermutation(colors, null), colors);
  assert.deepEqual(applySegmentPermutation(colors, [0]), colors); // wrong length, never partially applied
});

test("ledIndex matches CLAUDE.md's confirmed H6022 formula: row*cols+col", () => {
  const geometry = { rows: 11, cols: 12, wrapCol: true };
  assert.equal(ledIndex(geometry, 0, 0), 0);
  assert.equal(ledIndex(geometry, 1, 0), 12);
  assert.equal(ledIndex(geometry, 3, 5), 41);
});

test("frameCountFor: static motion is always exactly one frame", () => {
  assert.equal(frameCountFor({ type: "static" }, 2), 1);
});

test("frameCountFor: frameCount = round(periodSeconds * exportFps), per §5.4", () => {
  const motion = { type: "scroll" as const, axis: "col" as const, sign: 1 as const, periodSeconds: 6 };
  assert.equal(frameCountFor(motion, 2), 12);
  assert.equal(frameCountFor({ ...motion, periodSeconds: 3.3 }, 1), 3); // round(3.3) = 3
});

test("applyMotion: scroll wraps on a wrap-enabled column axis, never leaving gaps", () => {
  const geometry = { rows: 1, cols: 4, wrapCol: true };
  const canvas = new Uint8ClampedArray(4 * 3);
  canvas[0] = 255; // col 0 = red, rest black
  const motion = { type: "scroll" as const, axis: "col" as const, sign: 1 as const, periodSeconds: 4 };
  // fps=1, periodSeconds=4 -> frameCount=4, one frame = one column of shift
  const frame1 = applyMotion(canvas, geometry, motion, 1, 1);
  // shifted by 1: col1 should now hold what was at col0 (red)
  assert.equal(frame1[1 * 3], 255);
  const frame4 = applyMotion(canvas, geometry, motion, 4, 1);
  // a full cycle (shift=4 on a 4-wide wrap) returns to the original frame
  assert.deepEqual(Array.from(frame4), Array.from(canvas));
});

test("applyMotion: non-wrapping axis clamps the source column instead of wrapping", () => {
  const geometry = { rows: 1, cols: 4, wrapCol: false };
  const canvas = new Uint8ClampedArray(4 * 3);
  canvas[0] = 255; // col 0 = red, rest black
  const motion = { type: "scroll" as const, axis: "col" as const, sign: 1 as const, periodSeconds: 4 };
  // A shift large enough to push every destination's source column past 0
  // clamps back to col 0 (never wraps to col 3) — so the edge color holds
  // across the whole row rather than the content sliding off into black.
  const frame4 = applyMotion(canvas, geometry, motion, 4, 1);
  for (let col = 0; col < 4; col++) {
    assert.equal(frame4[col * 3], 255, `col ${col} should read the clamped col-0 source`);
  }
});

test("buildEffectSegments emits a keyframe only when a segment's color actually changes (§5.6 dedup)", () => {
  // 3 frames, 2 segments: segment 0 never changes; segment 1 changes once.
  const frames: [number, number, number][][] = [
    [
      [10, 10, 10],
      [0, 0, 0],
    ],
    [
      [10, 10, 10],
      [0, 0, 0],
    ],
    [
      [10, 10, 10],
      [50, 50, 50],
    ],
  ];
  const emitted = buildEffectSegments(frames, 1000);
  assert.equal(emitted[0].keyframes.length, 1); // segment 0: one keyframe total
  assert.equal(emitted[1].keyframes.length, 2); // segment 1: t=0 and the t=2000 change
  assert.deepEqual(emitted[1].keyframes[1], { t: 2000, color: "323232" });
});
