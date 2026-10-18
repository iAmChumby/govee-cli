/**
 * Issue #2: the ONE formatter for schedule times and the scheduler owner.
 *
 * The owner strip on Schedules and the rows in Settings > Connection both call
 * `formatOwner`, so they cannot disagree (grill G4; the same lesson as the
 * scene-appearance resolver: two fabrications will not agree).
 *
 * Wall times are sliced out of the server's ISO strings, which carry the
 * schedule zone's offset. They are never round-tripped through `Date` for
 * display, so a browser in another zone still sees the lamp's local time.
 * Minutes only: astral is ~2 min off other calculators, so seconds would
 * claim precision nobody has.
 */

import type { ScheduleList, SchedulerOwner } from "@/lib/api";

/** "2026-10-18T17:10:00-04:00" -> "17:10". */
export function wallHM(iso: string): string {
  return iso.slice(11, 16);
}

/** "2026-10-18T17:10:00-04:00" -> "2026-10-18". */
export function wallDate(iso: string): string {
  return iso.slice(0, 10);
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayDiff(fromDate: string, toDate: string): number {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const b = Date.UTC(+toDate.slice(0, 4), +toDate.slice(5, 7) - 1, +toDate.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** "Today 17:10" | "Tomorrow 06:30" | "Sun 18 Oct 17:10" — relative to the SERVER's now. */
export function formatRunAt(iso: string, nowIso: string): string {
  const date = wallDate(iso);
  const diff = dayDiff(wallDate(nowIso), date);
  if (diff === 0) return `Today ${wallHM(iso)}`;
  if (diff === 1) return `Tomorrow ${wallHM(iso)}`;
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${wallHM(iso)}`;
}

/** Next run, or the server's stated reason it has none. Never a guessed time. */
export function formatNextRun(nextRun: string | null, reason: string | null, nowIso: string): string {
  if (nextRun) return formatRunAt(nextRun, nowIso);
  return reason ?? "unknown";
}

/** "sunset 18:10, host: America/New_York" style zone label. */
export function formatZone(loc: ScheduleList["location"]): string {
  return loc.timezone_source === "host" ? `host: ${loc.timezone}` : loc.timezone;
}

function agoSeconds(fromIso: string, nowIso: string): number {
  return Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(fromIso)) / 1000));
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatAgo(fromIso: string, nowIso: string): string {
  const s = agoSeconds(fromIso, nowIso);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export interface OwnerDisplay {
  /** Short state word for the chip: "running" | "waiting" | "stale" | "not running" | "unknown". */
  chip: string;
  /** "warn" uses the warning treatment (glyph + text); "neutral" is plain chrome. Never green. */
  tone: "neutral" | "warn";
  /** The sentence: "Schedule owner: web console sidecar". */
  headline: string;
  /** Secondary facts: "last cycle 12s ago". Empty string when there are none. */
  detail: string;
}

function ownerName(owner: SchedulerOwner): string {
  if (owner.kind === "daemon") {
    return owner.pid !== null ? `govee-cli daemon (pid ${owner.pid})` : "govee-cli daemon";
  }
  if (owner.kind === "sidecar") {
    return owner.dry_run ? "web console sidecar (mock, dry run: sends nothing)" : "web console sidecar";
  }
  return "unknown process";
}

/**
 * The owner record as words. `stale_since` and `last_cycle_at` are absolute
 * instants; `nowIso` is the list's server `now`, so "ago" is server-relative.
 */
export function formatOwner(owner: SchedulerOwner, nowIso: string): OwnerDisplay {
  // The server measures the age; the ISO timestamps are minute-floored.
  const age = owner.last_cycle_age_seconds;
  const cycle =
    age !== null && age !== undefined
      ? `last cycle ${formatSeconds(age)} ago`
      : owner.last_cycle_at
        ? `last cycle ${formatAgo(owner.last_cycle_at, nowIso)}`
        : "";

  if (owner.this_process === "waiting" && owner.state === "running") {
    return {
      chip: "waiting",
      tone: "neutral",
      headline: `Schedule owner: ${ownerName(owner)}`,
      detail: ["this console is waiting for the lock", cycle].filter(Boolean).join(" · "),
    };
  }

  switch (owner.state) {
    case "running":
      return {
        chip: "running",
        tone: "neutral",
        headline: `Schedule owner: ${ownerName(owner)}`,
        detail: cycle,
      };
    case "stale":
      return {
        chip: "stale",
        tone: "warn",
        headline: `No scheduler running: rules will not fire (stale since ${owner.stale_since ? wallHM(owner.stale_since) : "unknown"})`,
        detail: [owner.detail, owner.kind ? `last owner ${ownerName(owner)}` : ""].filter(Boolean).join(" · "),
      };
    case "nobody":
      return {
        chip: "not running",
        tone: "warn",
        headline: "No scheduler running: rules will not fire",
        detail: owner.this_process === "disabled"
          ? "this console's scheduler is turned off (GOVEE_WEBUI_SCHEDULER=0)"
          : "start the web console sidecar or govee-cli daemon",
      };
    default:
      return {
        chip: "unknown",
        tone: "warn",
        headline: "Schedule owner unknown",
        detail: owner.detail ?? "the owner record could not be read",
      };
  }
}

/** "17:10 Evening" | "none yet" (only when the state file says so) | "unknown". */
export function formatLastFire(list: Pick<ScheduleList, "last_fire" | "state_readable">): string {
  if (!list.state_readable) return "unknown";
  if (!list.last_fire) return "none yet";
  return `${wallHM(list.last_fire.at)} ${list.last_fire.rule_name}`;
}
