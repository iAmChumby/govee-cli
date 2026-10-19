import type { ScheduleRule } from "@/lib/api";
import { formatRunAt, wallHM } from "@/lib/schedule-format";

export interface NextChange {
  names: string[];
  /** "at 17:10" | "tomorrow at 06:30" | "Sun 18 Oct at 17:10" */
  when: string;
}

/**
 * Every rule sharing the earliest server-computed next_run, joined by name.
 * No time maths: the instants are only compared, never produced here.
 */
export function nextChange(rules: ScheduleRule[], nowIso: string): NextChange | null {
  let best: number | null = null;
  let bestIso = "";
  for (const r of rules) {
    if (!r.enabled || !r.next_run) continue;
    const t = Date.parse(r.next_run);
    if (Number.isNaN(t)) continue;
    if (best === null || t < best) {
      best = t;
      bestIso = r.next_run;
    }
  }
  if (best === null) return null;
  const names = rules
    .filter((r) => r.enabled && r.next_run && Date.parse(r.next_run) === best)
    .map((r) => r.name);
  const label = formatRunAt(bestIso, nowIso);
  const hm = wallHM(bestIso);
  const when = label.startsWith("Today ")
    ? `at ${hm}`
    : label.startsWith("Tomorrow ")
      ? `tomorrow at ${hm}`
      : `${label.slice(0, -hm.length).trimEnd()} at ${hm}`;
  return { names, when };
}
