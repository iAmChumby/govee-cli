import { describe, expect, it } from "vitest";

import type { ScheduleRule } from "@/lib/api";

import { nextChange } from "./next-change";

const NOW = "2026-10-18T12:00:00-04:00";

function rule(name: string, next_run: string | null, enabled = true): ScheduleRule {
  return {
    id: name, name, time: "x", days: ["Sun"], command: "power on", enabled, device: null,
    room_scene: null, next_run, next_run_reason: null, today_fire: null, today_reason: null,
    target_problem: null, last_result: null, last_detail: null, last_at: null, missed_minute: null,
  };
}

describe("nextChange", () => {
  it("joins every rule sharing the earliest minute", () => {
    const got = nextChange(
      [
        rule("Evening", "2026-10-18T17:10:00-04:00"),
        rule("Porch", "2026-10-18T17:10:00-04:00"),
        rule("Late", "2026-10-18T22:00:00-04:00"),
        rule("Off", "2026-10-18T13:00:00-04:00", false),
      ],
      NOW,
    );
    expect(got).toEqual({ names: ["Evening", "Porch"], when: "at 17:10" });
  });

  it("words tomorrow and later days, and returns null with nothing to run", () => {
    expect(nextChange([rule("Wake", "2026-10-19T06:30:00-04:00")], NOW)?.when).toBe("tomorrow at 06:30");
    expect(nextChange([rule("Wake", "2026-10-21T06:30:00-04:00")], NOW)?.when).toBe("Wed 21 Oct at 06:30");
    expect(nextChange([rule("Ghost", null)], NOW)).toBeNull();
  });
});
