import type { CityMatch, ScheduleLocation } from "@/lib/api";
import { formatZone } from "@/lib/schedule-format";

import type { ConfigPatchBody } from "./sidecar";

/** Coordinates to two decimal places, the precision the UI shows everywhere. */
export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

/** The label of a stored city, or null when the location is raw coordinates. */
export function cityName(loc: Pick<ScheduleLocation, "name"> | undefined): string | null {
  const name = loc?.name?.trim();
  return name ? name : null;
}

/**
 * Current-location line for Settings. "not set" only when there are no
 * coordinates; a name is shown only when the sidecar reports one.
 */
export function describeLocation(loc: ScheduleLocation | undefined): string {
  if (!loc || loc.latitude === null || loc.longitude === null) return "not set";
  const coords = formatCoords(loc.latitude, loc.longitude);
  const name = cityName(loc);
  const head = name ? `${name} (${coords})` : coords;
  return `${head} · ${formatZone(loc)}`;
}

/** The PATCH body for picking a city. Timezone is omitted when absent, never guessed. */
export function cityPatch(match: CityMatch): ConfigPatchBody {
  const body: ConfigPatchBody = {
    latitude: match.latitude,
    longitude: match.longitude,
    location_name: match.label,
  };
  if (match.timezone) body.timezone = match.timezone;
  return body;
}

/** Whether the effective location is the one a pick should have stored. */
export function storedMatchesCity(loc: ScheduleLocation, match: CityMatch): boolean {
  if (loc.latitude === null || loc.longitude === null) return false;
  return Math.abs(loc.latitude - match.latitude) < 1e-4 && Math.abs(loc.longitude - match.longitude) < 1e-4;
}
