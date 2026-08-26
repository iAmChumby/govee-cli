/**
 * Tests for `dominantHsl` — the card's ambient bleed.
 *
 * The precedence it has to keep, in order: a running motion mode's palette
 * beats both live fields (they read back stale during a scene); a live colour
 * temperature beats a placeholder white; a real colour beats everything else.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { kelvinToRgb, rgbToHsl } from "@/components/stage/color";

import { dominantHsl } from "./dominant-hsl";
import type { ActiveMode } from "./types";

const NO_MOTION = { motionMode: null, model: "H6056" } as const;

test("a device at 2000 K bleeds amber, not the placeholder white it reports", () => {
  const hsl = dominantHsl({
    color: { rgb: [255, 255, 255] },
    colorTempK: 2000,
    ...NO_MOTION,
  });
  assert.deepEqual(hsl, rgbToHsl(kelvinToRgb(2000)));
});

test("a commanded colour still outranks a temperature reading", () => {
  const hsl = dominantHsl({ color: { rgb: [255, 0, 0] }, colorTempK: 2700, ...NO_MOTION });
  assert.deepEqual(hsl, rgbToHsl([255, 0, 0]));
});

test("a running motion mode still outranks both live fields", () => {
  const motionMode: ActiveMode = {
    kind: "diy_scene",
    name: "sleep",
    color: { r: 255, g: 255, b: 255 },
    colorTempK: 2000,
    confidence: "confirmed",
    ageSeconds: 30,
    source: "ui",
  };
  const hsl = dominantHsl({
    color: { rgb: [255, 255, 255] },
    colorTempK: 2000,
    motionMode,
    model: "H6056",
  });
  assert.notDeepEqual(hsl, rgbToHsl(kelvinToRgb(2000)));
});

test("solid motion mode classifies off the temperature when the colour is a placeholder", () => {
  const motionMode: ActiveMode = {
    kind: "solid",
    color: { r: 255, g: 255, b: 255 },
    colorTempK: 2000,
    confidence: "confirmed",
    ageSeconds: 5,
    source: "ui",
  };
  const hsl = dominantHsl({
    color: { rgb: [255, 255, 255] },
    colorTempK: 2000,
    motionMode,
    model: "H6056",
  });
  assert.deepEqual(hsl, rgbToHsl(kelvinToRgb(2000)));
});
