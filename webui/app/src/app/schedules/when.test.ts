import { describe, expect, it } from "vitest";

import { formatWhen, offsetLabel, parseWhen, shortWhen, stepOffset } from "./when";

describe("when helper", () => {
  it("round-trips a stored off-grid offset without rounding", () => {
    const parsed = parseWhen("sunset-1h10m");
    expect(parsed).toEqual({ kind: "sunset", offsetMinutes: -70 });
    expect(formatWhen(parsed!)).toBe("sunset-1h10m");
  });

  it("steps from the stored value, not from a snapped one", () => {
    expect(stepOffset(-70, -1)).toBe(-85);
    expect(stepOffset(-70, 1)).toBe(-55);
    expect(stepOffset(-10, 1)).toBe(5);
  });

  it("clamps at six hours either side", () => {
    expect(stepOffset(-360, -1)).toBe(-360);
    expect(stepOffset(355, 1)).toBe(360);
  });

  it("formats a zero offset as the bare event", () => {
    expect(formatWhen(parseWhen("sunset+0m")!)).toBe("sunset");
    expect(formatWhen(parseWhen("sunrise")!)).toBe("sunrise");
  });

  it("round-trips clock times and rejects malformed input", () => {
    expect(formatWhen(parseWhen("06:30")!)).toBe("06:30");
    expect(parseWhen("6:30")).toBeNull();
    expect(parseWhen("sunset-")).toBeNull();
    expect(parseWhen("noon")).toBeNull();
  });

  it("round-trips hour-only and minute-only offsets", () => {
    for (const s of ["sunrise-2h", "sunset+45m", "sunset+1h5m"]) {
      expect(formatWhen(parseWhen(s)!)).toBe(s);
    }
  });

  it("labels read in words", () => {
    expect(offsetLabel("sunset", -70)).toBe("1 h 10 m before sunset");
    expect(offsetLabel("sunrise", 45)).toBe("45 m after sunrise");
    expect(offsetLabel("sunset", 0)).toBe("at sunset");
    expect(shortWhen("sunset", -60)).toBe("sunset −1h");
  });
});
