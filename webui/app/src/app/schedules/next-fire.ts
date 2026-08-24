/* ==================================================================
   Next-fire math for schedule rules.
   ================================================================== */

const DAY_TO_JS_DAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Next datetime after `from` whose weekday is in `days` and whose wall
 * clock equals `time` ("HH:MM"). Scans at most one week forward, so
 * week wraparound (Sat -> Mon) falls out naturally.
 */
export function nextFireDateTime(
  time: string,
  days: string[],
  from: Date,
): Date | null {
  const [hh, mm] = time.split(":");
  const hour = Number(hh);
  const minute = Number(mm);
  const wanted = new Set(days.map((d) => DAY_TO_JS_DAY[d]));
  if (wanted.size === 0 || Number.isNaN(hour) || Number.isNaN(minute))
    return null;

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() > from.getTime() && wanted.has(candidate.getDay())) {
      return candidate;
    }
  }
  return null;
}

/** Relative-first rendering: "in 45m" · "in 12h" · then "Sat 07:00". */
export function formatNextFire(next: Date | null): string {
  if (!next) return "—";
  const minutes = Math.round((next.getTime() - Date.now()) / 60_000);
  if (minutes < 1) return "any moment";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  const weekday = next.toLocaleDateString("en-US", { weekday: "short" });
  const hh = String(next.getHours()).padStart(2, "0");
  const mm = String(next.getMinutes()).padStart(2, "0");
  return `${weekday} ${hh}:${mm}`;
}
