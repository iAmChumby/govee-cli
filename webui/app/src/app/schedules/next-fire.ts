/* ==================================================================
   Relative rendering for the EXTERNAL (crontab) panel only. Native rules
   get their next run from the server; the client-side next-fire maths
   that used to live here is gone.
   ================================================================== */

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
