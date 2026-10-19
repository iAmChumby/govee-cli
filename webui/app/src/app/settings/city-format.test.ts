import { describe, expect, it } from "vitest";

import type { CityMatch, ScheduleLocation } from "@/lib/api";

import { cityPatch, describeLocation, formatCoords, storedMatchesCity } from "./city-format";

const rochester: CityMatch = {
  name: "Rochester",
  region: "New York",
  country: "United States",
  label: "Rochester, New York, United States",
  latitude: 43.15478,
  longitude: -77.61556,
  timezone: "America/New_York",
  population: 209000,
};

const loc = (over: Partial<ScheduleLocation>): ScheduleLocation => ({
  latitude: 43.15478,
  longitude: -77.61556,
  timezone: "America/New_York",
  timezone_source: "config",
  name: null,
  ...over,
});

describe("city-format", () => {
  it("rounds coordinates to two decimals", () => {
    expect(formatCoords(43.15478, -77.61556)).toBe("43.15, -77.62");
  });

  it("describes a named location with coordinates and zone", () => {
    expect(describeLocation(loc({ name: rochester.label }))).toBe(
      "Rochester, New York, United States (43.15, -77.62) · America/New_York",
    );
  });

  it("falls back to coordinates when no name is stored", () => {
    expect(describeLocation(loc({}))).toBe("43.15, -77.62 · America/New_York");
    expect(describeLocation(loc({ name: "  " }))).toBe("43.15, -77.62 · America/New_York");
  });

  it("marks a host zone and reports not set without coordinates", () => {
    expect(describeLocation(loc({ timezone_source: "host" }))).toBe("43.15, -77.62 · host: America/New_York");
    expect(describeLocation(loc({ latitude: null, longitude: null }))).toBe("not set");
    expect(describeLocation(undefined)).toBe("not set");
  });

  it("builds the patch with the label and omits an absent timezone", () => {
    expect(cityPatch(rochester)).toEqual({
      latitude: 43.15478,
      longitude: -77.61556,
      timezone: "America/New_York",
      location_name: "Rochester, New York, United States",
    });
    expect(cityPatch({ ...rochester, timezone: null })).not.toHaveProperty("timezone");
  });

  it("checks a stored location against the picked city", () => {
    expect(storedMatchesCity(loc({}), rochester)).toBe(true);
    expect(storedMatchesCity(loc({ latitude: 44 }), rochester)).toBe(false);
    expect(storedMatchesCity(loc({ latitude: null, longitude: null }), rochester)).toBe(false);
  });
});
