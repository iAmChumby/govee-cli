"use client";

/* ==================================================================
   24-hour schedule timeline — WEBUI_V3_SPEC.md §6.4.

   One horizontal 00:00-24:00 rail combining native `ScheduleRule`
   occurrences (today only) with the crontab-discovered external
   automation (wake-ramp's duration band + generic cron points).
   Nothing here computes a next-fire time itself — that's §6.2's job,
   done server-side and carried on `ExternalScheduleEntry`; this file
   only lays out what it's handed, honestly:

   - An unreadable crontab replaces the *external* layer with a single
     hatched "unknown" band. Native occurrences still render — partial
     knowledge is shown as partial, never zeroed out (§6.6).
   - `estimated`-confidence markers (generic cron, read straight off a
     5-field cron expression) get a visibly lighter treatment than
     `exact` ones (native rules, wake-ramp) and a "~" tooltip prefix.
   - wake-ramp's own "will this actually fire today" comes from
     `wake_ramp_status.today_will_run`, never re-derived from the raw
     cron expression here — see external_schedule.py's next-fire
     module docstring for why ("30 6 * * *" alone can't tell you the
     weekend gating).
   ================================================================== */

import * as React from "react";
import { motion } from "motion/react";

import {
  Button,
  Chip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
  SunGlyph,
} from "@/components/ui";
import {
  type Hsl,
  WARM_HSL,
  basicHsl,
  hslaCss,
  hslCss,
} from "@/components/stage/color";
import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import { useWakeRampArm, useWakeRampDisarm } from "@/lib/queries";
import type { DeviceSummary, ExternalSchedule, ScheduleRule } from "@/lib/api";
import { wallHM } from "@/lib/schedule-format";

import { isSun, parseWhen, shortWhen } from "./when";

const GRID_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pctOfMinutes(minutes: number): number {
  return (Math.min(1440, Math.max(0, minutes)) / 1440) * 100;
}

function minutesOfDate(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * "MM HH * * *" -> {hour, minute}, only for the unambiguous single-value
 * case (no ranges/lists/steps/wildcards) — exactly what wake-ramp's own
 * line looks like. Anything more exotic returns null rather than guessing
 * where to draw a point.
 */
function parseSimpleCronTime(
  cronExpr: string | null,
): { hour: number; minute: number } | null {
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

function formatClock(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** "HH:MM" -> percent of the 24h rail. Positioning only; the minute itself is the server's. */
function pctOfWall(iso: string): number | null {
  const [hh, mm] = wallHM(iso).split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return pctOfMinutes(hh * 60 + mm);
}

/** The label a dot carries: "Evening · sunset −1h · 17:10" or "06:30 weekday wake". */
function dotLabel(rule: ScheduleRule): string {
  const when = parseWhen(rule.time);
  const at = rule.today_fire ? wallHM(rule.today_fire) : "";
  const base =
    when && when.kind !== "clock"
      ? `${rule.name} · ${shortWhen(when.kind, when.offsetMinutes)} · ${at}`
      : `${at} ${rule.name}`;
  return rule.enabled ? base : `${base} (disabled)`;
}

/** Best-effort device hue for the wake-ramp band (V3_VISUAL_DIRECTION.md §D
 *  "Schedules timeline" note): the target device's *current* color, at low
 *  alpha, standing in for "this automation touches that lamp" — falls back
 *  to the neutral warm chassis hue when the device isn't found or has no
 *  known color yet. `device_hint` is a comma-joined name list server-side. */
function deviceHueFor(devices: DeviceSummary[], hint: string | null): Hsl {
  if (!hint) return WARM_HSL;
  const wanted = hint.split(",").map((s) => s.trim().toLowerCase());
  const match = devices.find((d) => d.name && wanted.includes(d.name.toLowerCase()));
  if (!match) return WARM_HSL;
  return basicHsl(match.color?.rgb ?? null, match.color_temp_k ?? null);
}

/* ------------------------------------------------------------- markers */

/**
 * `forwardRef` is load-bearing, not decorative: every cron-entry marker
 * renders this inside `<PopoverTrigger asChild>` (below), and Radix's
 * Slot clones its own DOM ref onto the immediate child to register the
 * Popper anchor and the focus-restore-on-close target. A plain function
 * component silently drops that ref, leaving the popover with no anchor
 * to measure against — it would open unpositioned instead of pinned to
 * the marker that was tapped. `Button` (components/ui/button.tsx) is
 * `forwardRef` for the identical reason.
 */
const MarkerDot = React.forwardRef<
  HTMLButtonElement,
  {
    pct: number;
    tone: "accent" | "muted";
    dashed?: boolean;
    className?: string;
    onClick?: () => void;
    label: string;
  }
>(function MarkerDot({ pct, tone, dashed, className, onClick, label }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        // Visual dot stays 8px (the timeline reads as hairline points, not
        // buttons) but the actual tap target is grown to ~44px via an
        // invisible ::before overlay — this rail is dense enough on a phone
        // viewport that an 8px raw hit box is very hard to land a thumb on.
        "absolute h-2 w-2 -translate-x-1/2 cursor-pointer rounded-full border transition-transform duration-150 before:absolute before:-inset-[18px] before:content-[''] hover:scale-125",
        tone === "accent"
          ? "border-hi bg-hi"
          : dashed
            ? "border-dashed border-low bg-transparent"
            : "border-low bg-low/60",
        className,
      )}
      style={{ left: `${pct}%` }}
    />
  );
});

/* -------------------------------------------------------- wake-ramp band */

function WakeRampPopover({
  children,
  entry,
  devices,
}: {
  children: React.ReactNode;
  entry: ExternalSchedule["entries"][number];
  devices: DeviceSummary[];
}) {
  const [open, setOpen] = React.useState(false);
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

  const hsl = deviceHueFor(devices, entry.device_hint);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="center" className="w-64">
        <p className="text-[12px] font-medium text-hi">wake-ramp</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-low">
          {entry.device_hint ?? "unknown device"} · ramps 1% → 50% brightness at
          2000K over ~30 min (fixed to this one automation)
        </p>
        <div className="mt-3 flex items-center gap-2">
          <StatusDot tone={armedDate ? "ok" : "off"} />
          <span className="font-mono text-[11px] text-mid">
            {status === null
              ? "status unknown — script unreachable"
              : armedDate
                ? `armed for ${armedDate}`
                : "weekend: not armed"}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            busy={busy === "arm"}
            disabled={busy !== null || !!armedDate}
            onClick={() => void run("arm")}
          >
            arm
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
        <p
          className="mt-2 truncate font-mono text-[9px] text-low"
          style={{ color: hslCss(hsl) }}
          title="device color used for this band"
        >
          ● tinted from {entry.device_hint ?? "device"}&apos;s current color
        </p>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------- track */

export interface ScheduleTimelineProps {
  rules: ScheduleRule[];
  /** Server "now" in the schedule zone; the now-line is sliced from it, never from the browser clock. */
  nowIso: string | null;
  external: ExternalSchedule | undefined;
  externalLoading: boolean;
  devices: DeviceSummary[];
  onSelectRule?: (ruleId: string) => void;
}

/**
 * §6.4 — one 24h track. Native rule occurrences on top (solid dots),
 * external automation on the bottom half (wake-ramp band + generic cron
 * points), a now-line through both.
 */
export function ScheduleTimeline({
  rules,
  nowIso,
  external,
  externalLoading,
  devices,
  onSelectRule,
}: ScheduleTimelineProps) {
  const nowPct = nowIso ? pctOfWall(nowIso) : null;
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const railRef = React.useRef<HTMLDivElement>(null);

  const plotted = rules.filter((r) => r.today_fire !== null);
  const unplotted = rules.filter((r) => r.today_fire === null);
  const selected = plotted.filter((r) => selectedIds.includes(r.id));

  /** Tap on a dot: select it plus every dot whose centre sits within 44px of it
   *  (their 44px coarse hit boxes overlap), so none becomes unreachable. */
  const selectAround = (rule: ScheduleRule) => {
    const width = railRef.current?.clientWidth ?? 0;
    const centre = rule.today_fire ? pctOfWall(rule.today_fire) : null;
    const near =
      centre === null || width === 0
        ? [rule]
        : plotted.filter((r) => {
            const pct = r.today_fire ? pctOfWall(r.today_fire) : null;
            return pct !== null && (Math.abs(pct - centre) / 100) * width < 44;
          });
    setSelectedIds(near.map((r) => r.id));
  };

  const crontabUnreadable = external ? !external.crontab.readable : false;
  const wakeRampEntry = external?.entries.find((e) => e.kind === "wake-ramp");
  const cronEntries = external?.entries.filter((e) => e.kind === "cron") ?? [];

  // --- wake-ramp band geometry -----------------------------------------
  let bandStartPct: number | null = null;
  let bandEndPct: number | null = null;
  if (wakeRampEntry) {
    const start = parseSimpleCronTime(wakeRampEntry.cron_expr);
    if (start) {
      const startMin = start.hour * 60 + start.minute;
      bandStartPct = pctOfMinutes(startMin);
      bandEndPct =
        wakeRampEntry.duration_minutes != null
          ? pctOfMinutes(startMin + wakeRampEntry.duration_minutes)
          : null;
    }
  }
  const todayWillRun = wakeRampEntry?.wake_ramp_status?.today_will_run ?? null;
  const statusUnknown = wakeRampEntry ? wakeRampEntry.wake_ramp_status === null : false;
  const bandHsl = wakeRampEntry ? deviceHueFor(devices, wakeRampEntry.device_hint) : WARM_HSL;

  return (
    <div>
      <div
        ref={railRef}
        className="relative h-16 rounded-card border border-hairline bg-panel pointer-coarse:h-24"
      >
        {/* 3-hour gridlines */}
        {GRID_HOURS.map((h) => (
          <span
            key={h}
            aria-hidden
            className="absolute inset-y-1 w-px bg-hairline"
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}

        {/* external layer: hatched "unknown" band replaces it entirely when
            the crontab itself couldn't be read (§6.4/§6.6) */}
        {crontabUnreadable ? (
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-1 top-8 rounded-chip opacity-60"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, var(--hairline-strong) 0 5px, transparent 5px 10px)",
            }}
            title={external?.crontab.error ?? "crontab unreadable"}
          />
        ) : null}

        {/* wake-ramp duration band */}
        {!crontabUnreadable && wakeRampEntry && bandStartPct !== null ? (
          <WakeRampPopover entry={wakeRampEntry} devices={devices}>
            <button
              type="button"
              aria-label={`wake-ramp — ${statusUnknown ? "status unknown" : todayWillRun ? "will run today" : "will not run today"}`}
              // The button is a transparent hit box; the band ink is the inner
              // span. Fine pointer: box == ink (32..60px of the rail). Coarse:
              // the box is >=44x44 (ink width + 19px each side, 44px tall at
              // y=44..88 of the 96px rail) while the ink stays 28px tall at
              // y=52..80, and the dot row's boxes end at y=44 so nothing overlaps.
              className="group absolute bottom-1 top-8 w-[var(--band-w)] cursor-pointer pointer-coarse:bottom-0 pointer-coarse:top-11 pointer-coarse:-ml-[19px] pointer-coarse:w-[calc(var(--band-w)+38px)]"
              style={
                {
                  left: `${bandStartPct}%`,
                  "--band-w": bandEndPct !== null ? `${Math.max(1.5, bandEndPct - bandStartPct)}%` : "8px",
                } as React.CSSProperties
              }
            >
              <span
                aria-hidden
                className="absolute inset-0 rounded-chip border transition-transform duration-150 group-hover:scale-[1.03] pointer-coarse:inset-x-[19px] pointer-coarse:inset-y-2"
                style={{
                  backgroundColor: statusUnknown
                    ? "var(--accent-dim)"
                    : hslaCss(bandHsl, todayWillRun ? 0.22 : 0.08),
                  borderColor: statusUnknown
                    ? "var(--hairline-strong)"
                    : hslaCss(bandHsl, todayWillRun ? 0.55 : 0.28),
                  borderStyle: todayWillRun && !statusUnknown ? "solid" : "dashed",
                }}
              />
            </button>
          </WakeRampPopover>
        ) : null}

        {/* generic cron entries — muted dashed points, capped server-side at 20 */}
        {!crontabUnreadable
          ? cronEntries.flatMap((entry) =>
              entry.today_occurrences.map((iso, i) => {
                const d = new Date(iso);
                const pct = pctOfMinutes(minutesOfDate(d));
                const estimated = entry.next_fire_confidence === "estimated";
                return (
                  <Popover key={`${entry.id}-${i}`}>
                    <PopoverTrigger asChild>
                      <MarkerDot
                        pct={pct}
                        tone="muted"
                        dashed
                        className="bottom-2"
                        label={`${entry.command} — ${estimated ? "~" : ""}${formatClock(d.getHours(), d.getMinutes())}`}
                      />
                    </PopoverTrigger>
                    <PopoverContent align="center" className="w-72">
                      <p className="font-mono text-[10px] leading-snug text-mid">
                        {estimated ? "~" : ""}
                        {formatClock(d.getHours(), d.getMinutes())} ·{" "}
                        {estimated ? "estimated from cron syntax" : "exact"}
                      </p>
                      {/* §11.2(6): same title-only reveal as the raw
                          command line in external-panel.tsx's CronRow —
                          the popover already requires a tap to reach, but
                          once open the string still hid behind hover.
                          PopoverContent's own width (`w-72` below) already
                          bounds this, so wrapping needs no max-w lift. */}
                      <p
                        className="mt-1.5 truncate font-mono text-[10px] text-low pointer-coarse:whitespace-normal pointer-coarse:break-words"
                        title={entry.raw_line ?? undefined}
                      >
                        {entry.raw_line ?? entry.command}
                      </p>
                      {entry.today_occurrences_truncated ? (
                        <p className="mt-1.5 font-mono text-[9px] text-low">
                          +more today (capped at 20 shown)
                        </p>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                );
              }),
            )
          : null}

        {/* native rules at the server's today_fire; sun rules carry a glyph */}
        {plotted.map((rule) => {
          const pct = rule.today_fire ? pctOfWall(rule.today_fire) : null;
          if (pct === null) return null;
          const when = parseWhen(rule.time);
          const sun = when ? isSun(when.kind) : false;
          const label = dotLabel(rule);
          return (
            <motion.button
              key={rule.id}
              type="button"
              aria-label={label}
              aria-pressed={selectedIds.includes(rule.id)}
              data-volatile={sun ? "true" : undefined}
              onClick={() => {
                selectAround(rule);
                onSelectRule?.(rule.id);
              }}
              animate={{ opacity: rule.enabled ? 1 : 0.45 }}
              transition={springStandard}
              // The button box IS the hit area: ink-sized on a fine pointer,
              // 44x44 on a coarse one, with the visible dot on an inner span.
              // Centre y is fixed (13px fine, 24px coarse) so the rail's rows
              // never collide; dots within 44px of each other are all listed
              // by the inline label on tap (selectAround).
              className="absolute top-[13px] flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center pointer-coarse:top-[22px] pointer-coarse:h-11 pointer-coarse:w-11"
              style={{ left: `${pct}%` }}
            >
              <span
                className={cn(
                  "flex items-center justify-center rounded-full border border-accent-contrast bg-accent text-accent-contrast transition-transform duration-150 hover:scale-125",
                  sun ? "h-4 w-4" : "h-2.5 w-2.5",
                  selectedIds.includes(rule.id) && "ring-2 ring-hi/60",
                )}
              >
                {sun ? <SunGlyph size={10} /> : null}
              </span>
            </motion.button>
          );
        })}

        {/* now line */}
        {nowPct !== null ? (
          <div
            aria-hidden
            data-volatile="true"
            className="absolute inset-y-0 w-px bg-hi/70"
            style={{ left: `${nowPct}%` }}
          />
        ) : null}
      </div>

      {/* hour labels */}
      <div className="mt-1.5 flex justify-between font-mono text-[9px] text-low">
        {GRID_HOURS.filter((h) => h % 6 === 0).map((h) => (
          <span key={h}>{pad2(h % 24)}:00</span>
        ))}
      </div>

      {/* tapped dot(s): every rule within the overlapped span, each its own 44px-tall button */}
      {selected.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {selected.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelectRule?.(r.id)}
                className="min-h-7 w-full cursor-pointer rounded-chip border border-hairline px-2 py-1 text-left font-mono text-[11px] leading-snug text-mid hover:border-hairline-strong hover:text-hi pointer-coarse:min-h-11"
              >
                <span data-volatile={isSun(parseWhen(r.time)?.kind ?? "clock") ? "true" : undefined}>
                  {dotLabel(r)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : plotted.length > 0 ? (
        <p className="mt-2 font-mono text-[11px] leading-snug text-mid">tap a dot for its time</p>
      ) : null}

      {unplotted.length > 0 ? (
        <p className="mt-1 font-mono text-[11px] leading-snug text-mid">
          {unplotted.length} {unplotted.length === 1 ? "rule" : "rules"} not on today&apos;s timeline:{" "}
          {unplotted.map((r) => `${r.name} (${r.today_reason ?? "unknown"})`).join(", ")}
        </p>
      ) : null}

      {/* legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-low">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-accent-contrast bg-accent" /> native rule
        </span>
        <span className="flex items-center gap-1.5">
          <span className="flex h-3 w-3 items-center justify-center rounded-full border border-accent-contrast bg-accent text-accent-contrast">
            <SunGlyph size={8} />
          </span>
          sun rule
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-4 rounded-chip border border-hairline-strong bg-accent-dim" />
          wake-ramp (will run)
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-4 rounded-chip border border-dashed border-low" />
          wake-ramp (skipped)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-dashed border-low" /> est. cron
        </span>
        {crontabUnreadable ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-4 rounded-sm opacity-60"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg, var(--hairline-strong) 0 3px, transparent 3px 6px)",
              }}
            />
            crontab unreadable
          </span>
        ) : null}
        {externalLoading ? <Chip>loading external…</Chip> : null}
      </div>
    </div>
  );
}
