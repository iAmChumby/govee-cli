/**
 * The Connection section's schedule rows, as one pure mapping (grill G4).
 *
 * Every owner string comes from `formatOwner`, the same function the
 * Schedules owner strip calls, so the two surfaces cannot disagree. This
 * module is kept free of React so the vitest file can check it in node.
 */

import type { ScheduleList, SchedulerOwner } from "@/lib/api";
import { formatLastFire, formatOwner, type OwnerDisplay } from "@/lib/schedule-format";

/**
 * Stand-in owner for when the schedule list cannot be read at all. Routing
 * it through `formatOwner` keeps the wording on the one formatter instead of
 * a second string in this file.
 */
const UNREADABLE_OWNER: SchedulerOwner = {
  state: "unknown",
  kind: null,
  dry_run: false,
  pid: null,
  host: null,
  started_at: null,
  last_cycle_at: null,
  poll_seconds: null,
  stale_since: null,
  detail: "the schedule list could not be read",
  this_process: "owner",
};

export interface ConnectionScheduleRows {
  owner: OwnerDisplay;
  /** "10s" from the owner record, or "unknown" when no owner reports one. */
  pollLabel: string;
  /** "17:10 Evening" | "none yet" | "unknown", from formatLastFire. */
  lastFire: string;
}

export function connectionScheduleRows(list: ScheduleList | undefined): ConnectionScheduleRows {
  if (!list) {
    return {
      owner: formatOwner(UNREADABLE_OWNER, new Date().toISOString()),
      pollLabel: "unknown",
      lastFire: "unknown",
    };
  }
  return {
    owner: formatOwner(list.owner, list.now),
    pollLabel: list.owner.poll_seconds !== null ? `${list.owner.poll_seconds}s` : "unknown",
    lastFire: formatLastFire(list),
  };
}
