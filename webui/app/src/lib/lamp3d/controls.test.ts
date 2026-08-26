/**
 * Tests for `controls.ts`'s pure maths only — `clampElevation`,
 * `sphericalOffset`, `dragToAngles`, `shouldClaimGesture`. `attachOrbitControls`
 * itself (real pointer events on a real DOM element) is not unit-tested here;
 * see that function's own doc comment for why jsdom can't honestly exercise
 * it and where its behaviour is actually verified.
 */

import { describe, expect, it } from "vitest";
import { MAX_ELEVATION, MIN_ELEVATION, clampElevation, dragToAngles, shouldClaimGesture, sphericalOffset } from "./controls";

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

describe("shouldClaimGesture", () => {
  it("does not claim a drag shorter than the threshold, even if perfectly horizontal", () => {
    expect(shouldClaimGesture(3, 0)).toBe(false);
  });

  it("claims a clearly horizontal drag past the threshold", () => {
    expect(shouldClaimGesture(20, 2)).toBe(true);
  });

  it("does not claim a vertical-dominant drag — left to the page's own scroll", () => {
    expect(shouldClaimGesture(2, 20)).toBe(false);
  });

  it("does not claim a perfectly diagonal (equal) drag — horizontal must strictly dominate", () => {
    expect(shouldClaimGesture(20, 20)).toBe(false);
  });
});
