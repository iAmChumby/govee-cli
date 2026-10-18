"use client";

import { motion } from "motion/react";
import { TriangleAlert } from "lucide-react";

import { Chip, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import { useHealth, useSchedules } from "@/lib/queries";
import { panelIn } from "@/lib/motion";
import type { OwnerDisplay } from "@/lib/schedule-format";

import { connectionScheduleRows } from "./connection-owner";
import { ConfigRow } from "./field";

/**
 * The owner record as a stacked row. ConfigRow truncates its value on
 * desktop, and the owner headline is a full sentence that must not be cut
 * off, so this row wraps at every width.
 */
function OwnerRow({ owner }: { owner: OwnerDisplay }) {
  const warn = owner.tone === "warn";
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[11px] uppercase leading-none tracking-micro text-mid">
          schedule owner
        </span>
        <Chip tone={warn ? "warn" : "neutral"}>
          {warn ? <TriangleAlert size={11} strokeWidth={1.5} aria-hidden /> : null}
          {owner.chip}
        </Chip>
      </div>
      <p
        className={
          warn
            ? "mt-2 flex items-start gap-1.5 break-words font-mono text-[12px] leading-relaxed text-ember"
            : "mt-2 break-words font-mono text-[12px] leading-relaxed text-hi"
        }
      >
        {warn ? (
          <TriangleAlert size={13} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
        ) : null}
        <span>{owner.headline}</span>
      </p>
      {owner.detail ? (
        <p
          data-volatile="true"
          className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-low"
        >
          {owner.detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Connection health: sidecar version, mode, the schedule owner, and the
 * crontab-driven automation the scheduler can see. Read-only.
 *
 * The owner, poll interval and last fire come from the schedule list, and
 * every owner string goes through `formatOwner` (grill G4). Nothing here
 * reads `scheduler.native.alive`: a stale heartbeat is "stale since HH:MM",
 * never "running".
 *
 * `health.scheduler.external` keeps its honest tri-state. `wake_ramp_armed`
 * is `boolean | null`, and `null` is rendered literally as "unknown."
 */
export function ConnectionSection() {
  const health = useHealth();
  const schedules = useSchedules();
  const scheduler = health.data?.scheduler;
  const rows = connectionScheduleRows(schedules.data);

  return (
    <motion.section variants={panelIn}>
      <SectionLabel index={1} title="connection" />
      <Panel className="mt-3 p-5">
        {health.isLoading || schedules.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-40" />
          </div>
        ) : health.isError || !health.data || !scheduler ? (
          <p className="py-1 font-mono text-[11px] leading-relaxed text-low">
            sidecar unreachable — is the API running on 127.0.0.1:6057?
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            <ConfigRow label="status">{health.data.status}</ConfigRow>
            <ConfigRow label="sidecar version">v{health.data.version}</ConfigRow>
            <ConfigRow label="mode">
              <Chip>{health.data.mock ? "mock" : "live"}</Chip>
            </ConfigRow>

            {/* the schedule owner — one formatter, shared with the Schedules strip */}
            <OwnerRow owner={rows.owner} />
            <ConfigRow label="poll interval">{rows.pollLabel}</ConfigRow>
            <ConfigRow label="last fire">{rows.lastFire}</ConfigRow>

            {/* external — crontab-discovered automation the native runner
                can't see; §6.6 — an unreadable crontab is shown as such,
                never blurred into "0 automations". */}
            <ConfigRow label="crontab">
              <span className="inline-flex items-center gap-2">
                <StatusDot tone={scheduler.external.crontab_readable ? "ok" : "warn"} />
                {scheduler.external.crontab_readable ? "readable" : "unreadable"}
              </span>
            </ConfigRow>
            {!scheduler.external.crontab_readable && scheduler.external.error ? (
              <ConfigRow label="crontab error">{scheduler.external.error}</ConfigRow>
            ) : null}
            <ConfigRow label="wake-ramp armed">
              {scheduler.external.wake_ramp_armed === null
                ? "unknown"
                : scheduler.external.wake_ramp_armed
                  ? "armed"
                  : "not armed"}
            </ConfigRow>
            <ConfigRow label="external entries">{scheduler.external.entry_count}</ConfigRow>

            <ConfigRow label="polling">state 10s · health 60s</ConfigRow>
          </div>
        )}
      </Panel>
    </motion.section>
  );
}
