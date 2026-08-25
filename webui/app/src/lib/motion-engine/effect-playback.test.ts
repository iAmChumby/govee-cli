/**
 * Tests for `effect-playback.ts` — the TS port of `effect.py`'s
 * `_color_at`/`_frames` sampling (WEBUI_V3_SPEC.md §4.2 layer 3).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { colorAt, frameAt, totalDurationMs } from "./effect-playback";
import type { EffectDescriptor } from "./types";

test("colorAt clamps to the first keyframe before it starts", () => {
  const kfs = [
    { t: 1000, color: "ff0000" },
    { t: 2000, color: "0000ff" },
  ];
  assert.deepEqual(colorAt(kfs, 0), [255, 0, 0]);
  assert.deepEqual(colorAt(kfs, 500), [255, 0, 0]);
});

test("colorAt clamps to the last keyframe after it ends", () => {
  const kfs = [
    { t: 0, color: "ff0000" },
    { t: 1000, color: "0000ff" },
  ];
  assert.deepEqual(colorAt(kfs, 5000), [0, 0, 255]);
});

test("colorAt linearly interpolates at the midpoint", () => {
  const kfs = [
    { t: 0, color: "000000" },
    { t: 1000, color: "ffffff" },
  ];
  const [r, g, b] = colorAt(kfs, 500);
  // Math.floor(255 * 0.5) = 127 for each channel.
  assert.equal(r, 127);
  assert.equal(g, 127);
  assert.equal(b, 127);
});

test("colorAt on an empty keyframe list returns white rather than crashing", () => {
  assert.deepEqual(colorAt([], 100), [255, 255, 255]);
});

test("totalDurationMs is the max t across every segment's keyframes", () => {
  const effect: EffectDescriptor = {
    fps: 10,
    loop: false,
    startedAt: 0,
    segments: [
      { id: 0, keyframes: [{ t: 0, color: "ff0000" }, { t: 3000, color: "00ff00" }] },
      { id: 1, keyframes: [{ t: 0, color: "0000ff" }, { t: 1500, color: "ffffff" }] },
    ],
  };
  assert.equal(totalDurationMs(effect), 3000);
});

test("frameAt loops modulo the total duration when effect.loop is true", () => {
  const effect: EffectDescriptor = {
    fps: 10,
    loop: true,
    startedAt: 0,
    segments: [{ id: 0, keyframes: [{ t: 0, color: "000000" }, { t: 1000, color: "ffffff" }] }],
  };
  // 1500ms elapsed, 1000ms total -> wraps to 500ms -> midpoint gray.
  const colors = frameAt(effect, 1500);
  assert.deepEqual(colors[0], [127, 127, 127]);
});

test("frameAt clamps to the final frame once a non-looping effect finishes", () => {
  const effect: EffectDescriptor = {
    fps: 10,
    loop: false,
    startedAt: 0,
    segments: [{ id: 0, keyframes: [{ t: 0, color: "000000" }, { t: 1000, color: "ffffff" }] }],
  };
  const colors = frameAt(effect, 5000);
  assert.deepEqual(colors[0], [255, 255, 255]);
});

test("frameAt returns one color per segment id", () => {
  // Each segment needs a real (nonzero) duration — a single-keyframe segment
  // makes totalDurationMs() 0 across the whole effect, which is correctly
  // treated as degenerate (see the next test) rather than a real one-frame hold.
  const effect: EffectDescriptor = {
    fps: 10,
    loop: true,
    startedAt: 0,
    segments: [
      { id: 0, keyframes: [{ t: 0, color: "ff0000" }, { t: 1000, color: "ff0000" }] },
      { id: 5, keyframes: [{ t: 0, color: "00ff00" }, { t: 1000, color: "00ff00" }] },
      { id: 14, keyframes: [{ t: 0, color: "0000ff" }, { t: 1000, color: "0000ff" }] },
    ],
  };
  const colors = frameAt(effect, 100);
  assert.deepEqual(Object.keys(colors).map(Number).sort((a, b) => a - b), [0, 5, 14]);
});

test("frameAt on a degenerate (zero-duration) effect returns no colors rather than crashing", () => {
  const effect: EffectDescriptor = {
    fps: 10,
    loop: true,
    startedAt: 0,
    segments: [{ id: 0, keyframes: [] }],
  };
  assert.deepEqual(frameAt(effect, 100), {});
});
