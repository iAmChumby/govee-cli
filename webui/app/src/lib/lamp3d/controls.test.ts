/**
 * Tests for `controls.ts`'s pure maths only — `clampElevation`,
 * `sphericalOffset`, `dragToAngles`, `shouldClaimGesture`. `attachOrbitControls`
 * itself (real pointer events on a real DOM element) is not unit-tested here;
 * see that function's own doc comment for why jsdom can't honestly exercise
 * it and where its behaviour is actually verified.
 */

import { describe, expect, it } from "vitest";
import {
  INERTIA_STOP_THRESHOLD_RAD_PER_S,
  MAX_ELEVATION,
  MIN_ELEVATION,
  clampElevation,
  decayAngularVelocity,
  dragToAngles,
  shouldClaimGesture,
  sphericalOffset,
} from "./controls";

describe("clampElevation", () => {
  it("passes through values already inside the range", () => {
    expect(clampElevation(0.5)).toBe(0.5);
  });

  it("clamps below MIN_ELEVATION up to it — the camera can never reach or dip below the target's own height", () => {
    expect(clampElevation(-10)).toBe(MIN_ELEVATION);
    expect(clampElevation(0)).toBe(MIN_ELEVATION);
  });

  it("clamps above MAX_ELEVATION down to it — never straight overhead", () => {
    expect(clampElevation(Math.PI)).toBe(MAX_ELEVATION);
    expect(clampElevation(Math.PI / 2)).toBe(MAX_ELEVATION);
  });
});

describe("sphericalOffset", () => {
  it("at elevation 0, produces no vertical component", () => {
    const [, y] = sphericalOffset(0.7, 0, 5);
    expect(y).toBeCloseTo(0);
  });

  it("at elevation PI/2, points straight up regardless of azimuth", () => {
    const [x, y, z] = sphericalOffset(1.234, Math.PI / 2, 5);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(5);
    expect(z).toBeCloseTo(0);
  });

  it("always has magnitude equal to radius, at any azimuth/elevation", () => {
    const radius = 3.7;
    for (const azimuth of [0, 0.5, 2, -1.3]) {
      for (const elevation of [MIN_ELEVATION, 0.5, MAX_ELEVATION]) {
        const [x, y, z] = sphericalOffset(azimuth, elevation, radius);
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        expect(magnitude).toBeCloseTo(radius, 5);
      }
    }
  });

  it("keeps y >= 0 across the whole clamped elevation range — never below the target's height", () => {
    for (const elevation of [MIN_ELEVATION, 0.3, 0.8, MAX_ELEVATION]) {
      const [, y] = sphericalOffset(0.9, elevation, 4);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("dragToAngles", () => {
  it("inverts elevation's sign relative to azimuth's: dragging up tilts the view up", () => {
    const { dAzimuth, dElevation } = dragToAngles(10, -10);
    expect(dAzimuth).not.toBe(0);
    expect(dElevation).toBeGreaterThan(0); // negative dy (drag up) -> positive elevation delta
  });

  it("scales linearly with drag distance", () => {
    const small = dragToAngles(5, 0);
    const large = dragToAngles(10, 0);
    expect(large.dAzimuth).toBeCloseTo(small.dAzimuth * 2);
  });

  it("produces zero angles for zero drag", () => {
    // `-0 * speed` is `-0`, not `0` — a real IEEE-754 distinction `toBe`
    // (`Object.is`) treats as a mismatch, not a bug in `dragToAngles`
    // itself, so this compares numeric value rather than exact float sign.
    const { dAzimuth, dElevation } = dragToAngles(0, 0);
    expect(Math.abs(dAzimuth)).toBe(0);
    expect(Math.abs(dElevation)).toBe(0);
  });
});

describe("shouldClaimGesture — touch (horizontal must dominate, page scroll wins ties)", () => {
  it("does not claim a drag shorter than the threshold, even if perfectly horizontal", () => {
    expect(shouldClaimGesture(3, 0, "touch")).toBe(false);
  });

  it("claims a clearly horizontal drag past the threshold", () => {
    expect(shouldClaimGesture(20, 2, "touch")).toBe(true);
  });

  it("does not claim a vertical-dominant drag — left to the page's own scroll", () => {
    expect(shouldClaimGesture(2, 20, "touch")).toBe(false);
  });

  it("does not claim a perfectly diagonal (equal) drag — horizontal must strictly dominate", () => {
    expect(shouldClaimGesture(20, 20, "touch")).toBe(false);
  });
});

describe("shouldClaimGesture — mouse and pen (claim in any direction past the threshold)", () => {
  // This is the regression the task asked for: before the split, a mouse
  // drag ran through the exact same "horizontal must dominate" rule as
  // touch, so a user dragging straight up to tilt the camera got no
  // response — `shouldClaimGesture(2, 20)` was `false` for every pointer
  // type. A vertical-dominant mouse drag must now claim, because nothing
  // on the page competes with a mouse drag the way scroll competes with a
  // touch drag.
  it("claims a vertical-dominant mouse drag past the threshold", () => {
    expect(shouldClaimGesture(2, 20, "mouse")).toBe(true);
  });

  it("claims a vertical-dominant pen drag past the threshold", () => {
    expect(shouldClaimGesture(1, 15, "pen")).toBe(true);
  });

  it("claims a horizontal mouse drag past the threshold too", () => {
    expect(shouldClaimGesture(20, 2, "mouse")).toBe(true);
  });

  it("does not claim a mouse drag whose total magnitude is still under the threshold", () => {
    expect(shouldClaimGesture(2, 3, "mouse")).toBe(false);
  });

  it("claims a perfectly diagonal mouse drag once its magnitude clears the threshold", () => {
    // Touch requires strict horizontal dominance and would reject this
    // (adx === ady); mouse has no such requirement.
    expect(shouldClaimGesture(20, 20, "mouse")).toBe(true);
  });
});

describe("decayAngularVelocity", () => {
  it("halves the velocity after exactly one half-life, well above the stop threshold", () => {
    const start = 3;
    const after = decayAngularVelocity(start, 0.35);
    expect(after).toBeCloseTo(1.5, 5);
  });

  it("leaves velocity unchanged for a zero or negative dt", () => {
    expect(decayAngularVelocity(1.2, 0)).toBe(1.2);
    expect(decayAngularVelocity(1.2, -1)).toBe(1.2);
  });

  it("snaps to exactly zero once decay drops it below the stop threshold", () => {
    // A tiny velocity decays to something below the threshold almost
    // immediately, and must read as a hard zero rather than an
    // imperceptible-but-nonzero tail that keeps an inertia loop alive.
    const result = decayAngularVelocity(INERTIA_STOP_THRESHOLD_RAD_PER_S * 1.5, 2);
    expect(result).toBe(0);
  });

  it("preserves sign while decaying — a leftward coast stays leftward", () => {
    const after = decayAngularVelocity(-3, 0.1);
    expect(after).toBeLessThan(0);
  });

  it("eventually reaches exactly zero given enough elapsed time", () => {
    let velocity = 5;
    for (let i = 0; i < 200; i++) {
      velocity = decayAngularVelocity(velocity, 0.05);
    }
    expect(velocity).toBe(0);
  });
});
