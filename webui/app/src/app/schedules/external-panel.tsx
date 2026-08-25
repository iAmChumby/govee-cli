"use client";

/* ==================================================================
   External Automation — WEBUI_V3_SPEC.md §6.3.

   Read-only-but-real: crontab-discovered automation the native rule
   store (`schedule.json`) has never known about, chiefly the
   06:30-weekday `wake-ramp` line that started this whole feature
   (§1.2 — "the Schedules page shows 0 rules but a light changes every
   morning"). Deliberately a separate `Panel` from Native Rules, never
   merged into one list: this data has no `Switch`/`Delete` because the
   sidecar has no writable relationship to a crontab line it doesn't
   own — arm/disarm is the one narrow exception, scoped to the single
   wake-ramp binary by exact path server-side.

   Three states this panel must never blur together (§6.6):
   - `crontab.readable === false`  -> a banner, not "0 automations".
   - `readable && entries.length === 0` -> a quieter, distinct positive
     statement — genuinely empty is not the same claim as "couldn't look".
   - a `snapshot`-sourced read -> its age is shown; never presented as live.
   ================================================================== */

import * as React from "react";
import { motion } from "motion/react";
import { AlertTriangle, Lock } from "lucide-react";

import { Button, Chip, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import { ApiError, type CrontabStatus, type ExternalScheduleEntry } from "@/lib/api";
import { useExternalSchedules, useWakeRampArm, useWakeRampDisarm } from "@/lib/queries";
import { panelIn } from "@/lib/motion";

import { formatNextFire } from "./next-fire";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function formatStaleAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** Never a blank cell, never a silent guess — §6.1/§6.6. `unknown`
 *  confidence always renders the literal word, even when a stale
 *  `next_fire` value happens to still be sitting on the entry. */
function formatExternalNextFire(entry: ExternalScheduleEntry): string {
  if (entry.next_fire_confidence === "unknown" || !entry.next_fire) return "unknown";
  const rendered = formatNextFire(new Date(entry.next_fire));
  return entry.next_fire_confidence === "estimated" ? `~${rendered}` : rendered;
}

/** "MM HH * * *" -> {hour, minute} for the unambiguous single-value case
 *  only (mirrors timeline.tsx's parser — kept local so each file stays
 *  self-contained, matching this codebase's existing per-file clock/format
 *  helper convention, e.g. next-fire.ts vs. status-strip's own useClock). */
function parseSimpleCronTime(cronExpr: string | null): { hour: number; minute: number } | null {
  if (!cronExpr) return null;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 2) return null;
  const [minuteField, hourField] = fields;
  if (!/^\d{1,2}$/.test(minuteField) || !/^\d{1,2}$/.test(hourField)) return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function rampWindowText(entry: ExternalScheduleEntry): string {
  const start = parseSimpleCronTime(entry.cron_expr);
  if (!start) return "";
  const startLabel = `${pad2(start.hour)}:${pad2(start.minute)}`;
  if (entry.duration_minutes == null) return ` starting ${startLabel}`;
  const endTotal = start.hour * 60 + start.minute + entry.duration_minutes;
  const endLabel = `${pad2(Math.floor(endTotal / 60) % 24)}:${pad2(endTotal % 60)}`;
  return ` over ${startLabel}–${endLabel}`;
}

/* ------------------------------------------------------------ caption */

function SourceCaption({ crontab }: { crontab: CrontabStatus }) {
  return (
    <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-low">
      source: {crontab.source} · read-only
      {crontab.source === "snapshot" && crontab.stale_seconds !== null
        ? ` · cached ${formatStaleAge(crontab.stale_seconds)}`
        : ""}
    </p>
  );
}

/* --------------------------------------------------------------- rows */

function WakeRampRow({ entry, crontab }: { entry: ExternalScheduleEntry; crontab: CrontabStatus }) {
  const [busy, setBusy] = React.useState<"arm" | "disarm" | null>(null);
  const arm = useWakeRampArm();
  const disarm = useWakeRampDisarm();
  const status = entry.wake_ramp_status;
  const armedDate = status?.armed_date ?? null;

  const run = async (action: "arm" | "disarm") => {
    setBusy(action);
    try {
      await (action === "arm" ? arm() : disarm());
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-card border border-dashed border-hairline-strong/60 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Lock size={12} strokeWidth={1.5} className="shrink-0 text-low" aria-hidden />
        <p className="text-[13px] font-medium leading-tight text-hi">wake-ramp</p>
        {entry.device_hint ? <Chip>{entry.device_hint}</Chip> : null}
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-mid">
          <StatusDot tone={armedDate ? "ok" : "off"} />
          {status === null
            ? "status unknown"
            : armedDate
              ? `armed · ${armedDate}`
              : "weekend: not armed"}
        </span>
        <span data-volatile="true" className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-low" title="next fire">
          next: {formatExternalNextFire(entry)}
        </span>
      </div>

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-low">
        ramps {entry.device_hint ?? "the target device"} 1% → 50% brightness at 2000K
        {rampWindowText(entry)}
        {status?.weekdays_always ? " · weekdays always" : ""}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          busy={busy === "arm"}
          disabled={busy !== null || !!armedDate}
          onClick={() => void run("arm")}
        >
          arm weekend
        </Button>
        <Button
          size="sm"
          variant="ghost"
          busy={busy === "disarm"}
          disabled={busy !== null || !armedDate}
          onClick={() => void run("disarm")}
        >
          disarm
        </Button>
      </div>

      <div className="mt-2.5 border-t border-hairline pt-2">
        <SourceCaption crontab={crontab} />
      </div>
    </li>
  );
}

function CronRow({ entry, crontab }: { entry: ExternalScheduleEntry; crontab: CrontabStatus }) {
  return (
    <li className="rounded-card border border-dashed border-hairline px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Lock size={12} strokeWidth={1.5} className="shrink-0 text-low" aria-hidden />
        {/* §11.2(6): the raw crontab line behind this entry is
            hover-only via `title` today. Wrapping under pointer:coarse
            recovers it on a phone; `max-w-full` already bounds this to
            the row's own width so there is nothing narrower to lift. */}
        <span
          className="max-w-full truncate font-mono text-[11px] text-mid pointer-coarse:whitespace-normal pointer-coarse:break-words"
          title={entry.raw_line ?? entry.command}
        >
          {entry.command}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-low" title={entry.cron_expr ?? undefined}>
          {entry.cron_expr ?? "—"}
        </span>
        <span data-volatile="true" className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-low" title="next fire">
          next: {formatExternalNextFire(entry)}
        </span>
      </div>
      {entry.parse_error ? (
        <p className="mt-1.5 font-mono text-[10px] leading-snug text-ember">{entry.parse_error}</p>
      ) : null}
      <div className="mt-2 border-t border-hairline pt-2">
        <SourceCaption crontab={crontab} />
      </div>
    </li>
  );
}

/* -------------------------------------------------------------- panel */

export function ExternalAutomationPanel() {
  const external = useExternalSchedules();

  return (
    <motion.section variants={panelIn}>
      <SectionLabel index={3} title="external automation" />
      <Panel className="mt-3 p-5">
        {external.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : external.isError || !external.data ? (
          <p className="py-1 font-mono text-[11px] leading-relaxed text-low">
            external automation unavailable — {errMessage(external.error)}
          </p>
        ) : !external.data.crontab.readable ? (
          <div className="flex items-start gap-2.5 rounded-card border border-ember/30 bg-ember/[0.06] px-3.5 py-3">
            <AlertTriangle size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ember" aria-hidden />
            <p className="font-mono text-[11px] leading-relaxed text-ember">
              External automation status unknown — could not read crontab (
              {external.data.crontab.error ?? "unknown error"}
              ). Lighting may still be running on a schedule this page cannot see.
            </p>
          </div>
        ) : external.data.entries.length === 0 ? (
          <p className="py-2 font-mono text-[11px] leading-relaxed text-low">
            No external govee-cli automation found in crontab.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {external.data.entries.map((entry) =>
              entry.kind === "wake-ramp" ? (
                <WakeRampRow key={entry.id} entry={entry} crontab={external.data.crontab} />
              ) : (
                <CronRow key={entry.id} entry={entry} crontab={external.data.crontab} />
              ),
            )}
          </ul>
        )}
      </Panel>
    </motion.section>
  );
}
