import { describe, expect, it } from "vitest";

import type { ScheduleList, SchedulerOwner } from "@/lib/api";
import { formatOwner } from "@/lib/schedule-format";

import { connectionScheduleRows } from "./connection-owner";

const NOW = "2026-10-18T17:20:00-04:00";

const base: SchedulerOwner = {
  state: "running",
  kind: "sidecar",
  dry_run: false,
  pid: null,
  host: "pop-os",
  started_at: "2026-10-18T09:00:00-04:00",
  last_cycle_at: "2026-10-18T17:19:48-04:00",
  poll_seconds: 10,
  stale_since: null,
  detail: null,
  this_process: "owner",
};

function list(owner: SchedulerOwner, extra: Partial<ScheduleList> = {}): ScheduleList {
  return {
    schedules: [],
    owner,
    location: {
      latitude: 51.5,
      longitude: -0.12,
      timezone: "Europe/London",
      timezone_source: "config",
    },
    now: NOW,
    last_fire: null,
    state_readable: true,
    ...extra,
  };
}

/** One owner per state the Connection section can receive. */
const STATES: Array<{ name: string; owner: SchedulerOwner }> = [
  { name: "running sidecar", owner: base },
  {
    name: "running daemon",
    owner: { ...base, kind: "daemon", pid: 4242, dry_run: false },
  },
  {
    name: "waiting",
    owner: { ...base, kind: "daemon", pid: 4242, this_process: "waiting" },
  },
  {
    name: "stale",
    owner: {
      ...base,
      state: "stale",
      kind: "daemon",
      pid: 99,
      last_cycle_at: null,
      stale_since: "2026-10-18T16:55:00-04:00",
      detail: "heartbeat file is 25m old",
    },
  },
  {
    name: "nobody",
    owner: { ...base, state: "nobody", kind: null, poll_seconds: null, last_cycle_at: null },
  },
  {
    name: "nobody + disabled",
    owner: {
      ...base,
      state: "nobody",
      kind: null,
      poll_seconds: null,
      last_cycle_at: null,
      this_process: "disabled",
    },
  },
  {
    name: "unknown",
    owner: {
      ...base,
      state: "unknown",
      kind: null,
      poll_seconds: null,
      last_cycle_at: null,
      detail: "owner file is not valid JSON",
    },
  },
  {
    name: "dry-run sidecar",
    owner: { ...base, dry_run: true },
  },
];

describe("connectionScheduleRows owner row", () => {
  for (const { name, owner } of STATES) {
    it(`renders the ${name} owner exactly as formatOwner does`, () => {
      const l = list(owner);
      const rows = connectionScheduleRows(l);
      expect(rows.owner).toEqual(formatOwner(owner, l.now));
    });
  }

  it("running sidecar: neutral, never green, cycle age from the owner", () => {
    const row = connectionScheduleRows(list(base)).owner;
    expect(row.chip).toBe("running");
    expect(row.tone).toBe("neutral");
    expect(row.headline).toBe("Schedule owner: web console sidecar");
    expect(row.detail).toBe("last cycle 12s ago");
  });

  it("running daemon names its pid", () => {
    const row = connectionScheduleRows(
      list({ ...base, kind: "daemon", pid: 4242 }),
    ).owner;
    expect(row.headline).toBe("Schedule owner: govee-cli daemon (pid 4242)");
  });

  it("waiting says this console is waiting for the held lock", () => {
    const row = connectionScheduleRows(
      list({ ...base, kind: "daemon", pid: 4242, this_process: "waiting" }),
    ).owner;
    expect(row.chip).toBe("waiting");
    expect(row.detail).toBe("this console is waiting for the lock · last cycle 12s ago");
  });

  it("stale reads 'stale since HH:MM' with warn tone and never 'running'", () => {
    const row = connectionScheduleRows(
      list({
        ...base,
        state: "stale",
        kind: "daemon",
        pid: 99,
        last_cycle_at: null,
        stale_since: "2026-10-18T16:55:00-04:00",
      }),
    ).owner;
    expect(row.tone).toBe("warn");
    expect(row.chip).toBe("stale");
    expect(row.headline).toBe(
      "No scheduler running: rules will not fire (stale since 16:55)",
    );
    expect(row.chip).not.toBe("running");
    expect(row.detail).toBe("last owner govee-cli daemon (pid 99)");
  });

  it("nobody says no scheduler is running", () => {
    const row = connectionScheduleRows(
      list({ ...base, state: "nobody", kind: null, poll_seconds: null, last_cycle_at: null }),
    ).owner;
    expect(row.chip).toBe("not running");
    expect(row.tone).toBe("warn");
    expect(row.headline).toBe("No scheduler running: rules will not fire");
    expect(row.detail).toBe("start the web console sidecar or govee-cli daemon");
  });

  it("nobody + disabled names the env switch", () => {
    const row = connectionScheduleRows(
      list({
        ...base,
        state: "nobody",
        kind: null,
        poll_seconds: null,
        last_cycle_at: null,
        this_process: "disabled",
      }),
    ).owner;
    expect(row.detail).toBe("this console's scheduler is turned off (GOVEE_WEBUI_SCHEDULER=0)");
  });

  it("unknown is warn and says unknown, not running or stopped", () => {
    const row = connectionScheduleRows(
      list({ ...base, state: "unknown", kind: null, poll_seconds: null, last_cycle_at: null, detail: "x" }),
    ).owner;
    expect(row.chip).toBe("unknown");
    expect(row.tone).toBe("warn");
    expect(row.headline).toBe("Schedule owner unknown");
    expect(row.detail).toBe("x");
  });

  it("dry-run sidecar says it sends nothing", () => {
    const row = connectionScheduleRows(list({ ...base, dry_run: true })).owner;
    expect(row.headline).toBe(
      "Schedule owner: web console sidecar (mock, dry run: sends nothing)",
    );
  });

  it("an unreadable schedule list is an unknown owner through formatOwner", () => {
    const rows = connectionScheduleRows(undefined);
    expect(rows.owner.chip).toBe("unknown");
    expect(rows.owner.headline).toBe("Schedule owner unknown");
    expect(rows.owner.detail).toBe("the schedule list could not be read");
    expect(rows.pollLabel).toBe("unknown");
    expect(rows.lastFire).toBe("unknown");
  });
});

describe("connectionScheduleRows poll and last fire", () => {
  it("poll interval comes from the owner record", () => {
    expect(connectionScheduleRows(list(base)).pollLabel).toBe("10s");
    expect(
      connectionScheduleRows(list({ ...base, state: "nobody", poll_seconds: null })).pollLabel,
    ).toBe("unknown");
  });

  it("last fire is 'none yet' only when the state file says so", () => {
    expect(connectionScheduleRows(list(base)).lastFire).toBe("none yet");
  });

  it("last fire shows HH:MM and rule name", () => {
    const rows = connectionScheduleRows(
      list(base, {
        last_fire: {
          rule_id: "r1",
          rule_name: "Evening",
          at: "2026-10-18T17:10:00-04:00",
          result: "ok",
        },
      }),
    );
    expect(rows.lastFire).toBe("17:10 Evening");
  });

  it("an unreadable state file reads unknown, never none yet", () => {
    expect(connectionScheduleRows(list(base, { state_readable: false })).lastFire).toBe("unknown");
  });
});
