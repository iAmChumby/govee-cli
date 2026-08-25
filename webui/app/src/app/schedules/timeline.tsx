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
  hslaCss,
  hslCss,
  kelvinToRgb,
  rgbToHsl,
} from "@/components/stage/color";
import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import { useWakeRampArm, useWakeRampDisarm } from "@/lib/queries";
import type { DeviceSummary, ExternalSchedule, ScheduleRule } from "@/lib/api";

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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

/** Local clock that only ticks once a minute — a timeline "now" line has
 *  no need for anything finer, and this deliberately isn't a MotionValue
 *  per §6.4 ("percentage-math positioned"). Mount-gated so SSR and the
 *  first client render agree (no hydration mismatch on the exact minute). */
function useMinuteClock(): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
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
  if (match.color) return rgbToHsl(match.color.rgb);
  if (match.color_temp_k) return rgbToHsl(kelvinToRgb(match.color_temp_k));
  return WARM_HSL;
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
  external,
  externalLoading,
  devices,
  onSelectRule,
}: ScheduleTimelineProps) {
  const now = useMinuteClock();
  const todayAbbr = now ? DAY_ABBR[now.getDay()] : null;
  const nowPct = now ? pctOfMinutes(minutesOfDate(now)) : null;

  const todaysRules = React.useMemo(
    () => (todayAbbr ? rules.filter((r) => r.days.includes(todayAbbr)) : []),
    [rules, todayAbbr],
  );

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
      <div className="relative h-16 rounded-card border border-hairline bg-panel">
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
              // A 30-minute band can render only a few px wide on a phone's
              // 24h-width rail (at 390px the rail's content box is ~298px,
              // so a 30min band is ~6px — matches the ~6x26 raw box the
              // audit measures here).
              //
              // KNOWN BUG, not papered over with data-touch-ok (§11.1): this
              // ::before overlay does not clear 44px, and the class list
              // below does not match what an earlier version of this
              // comment claimed. `before:-inset-y-2 before:-inset-x-5` grows
              // width to 6+2*20=46px (clears 44) but height to only
              // 26+2*8=42px — 2px short of the floor. And because it DOES
              // grow vertically (contrary to a prior "horizontal insets
              // only" claim here), it bleeds into the native-rule dots' row
              // directly above: that row's own ::before reaches from
              // top-2(8px)-17px=-9px to (8+10)+17px=35px, this band's
              // reaches from top-8(32px)-8px=24px to (32+28)+8px=68px —
              // an 11px vertical overlap (24px to 35px) between two
              // invisible hit rectangles, exactly what §11.1 and the spec's
              // T36 note ("transparent ::after overlay bigger than the
              // laid-out box ... taps land on the neighbour") warn against.
              // A real fix needs the rail's row geometry reworked (more
              // vertical clearance between the dot row and the band row, or
              // a pointer-coarse-scoped real box grow per §11.3 rather than
              // a phantom overlay) — not a wider inset here.
              className="absolute bottom-1 top-8 flex cursor-pointer items-center justify-center rounded-chip border transition-transform duration-150 before:absolute before:-inset-y-2 before:-inset-x-5 before:content-[''] hover:scale-[1.03]"
              style={{
                left: `${bandStartPct}%`,
                width: bandEndPct !== null ? `${Math.max(1.5, bandEndPct - bandStartPct)}%` : "8px",
                backgroundColor: statusUnknown
                  ? "var(--accent-dim)"
                  : hslaCss(bandHsl, todayWillRun ? 0.22 : 0.08),
                borderColor: statusUnknown
                  ? "var(--hairline-strong)"
                  : hslaCss(bandHsl, todayWillRun ? 0.55 : 0.28),
                borderStyle: todayWillRun && !statusUnknown ? "solid" : "dashed",
              }}
            >
              {todayWillRun && !statusUnknown ? (
                <SunGlyph size={11} className="text-hi/70" />
              ) : null}
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

        {/* native rule occurrences, today only */}
        {todaysRules.map((rule) => {
          const [hh, mm] = rule.time.split(":").map(Number);
          if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
          const pct = pctOfMinutes(hh * 60 + mm);
          return (
            <motion.button
              key={rule.id}
              type="button"
              aria-label={`${rule.name} — ${rule.time}${rule.enabled ? "" : " (disabled)"}`}
              title={`${rule.name} · ${rule.time}`}
              onClick={() => onSelectRule?.(rule.id)}
              animate={{ opacity: rule.enabled ? 1 : 0.45 }}
              transition={springStandard}
              // Same invisible-hit-area treatment as MarkerDot below — a
              // 10px visual dot whose uniform before:-inset-[17px] reaches
              // exactly 10+2*17=44px on every side in isolation.
              //
              // KNOWN GAP, left un-exempted deliberately: isolated math is
              // not the whole story on a dense day. The rail's content box
              // is ~298px wide for 1440 minutes (~0.207px/min), so this
              // dot's 44px hit box (±22px) needs >=~212 minutes (~3h33m)
              // between two rule times before their invisible zones stop
              // touching — two rules an hour apart sit only ~12px apart,
              // deep inside each other's hit rectangles, so a tap can
              // resolve to whichever dot paints later in the `rules` array
              // rather than the one visually under the finger. The same
              // ::before also reaches down to y=35px, overlapping the
              // wake-ramp band's own (buggy) expanded zone starting at
              // y=24px whenever both sit near the same time of day. This is
              // the exact anti-pattern the spec's T36 note names ("taps
              // land on the neighbour ... a worse bug ... and an invisible
              // one") — not exempted with data-touch-ok because it does not
              // hold up, and not widened further because that only makes
              // the collision worse. Needs the same rail geometry rework as
              // the wake-ramp band above.
              className="absolute top-2 h-2.5 w-2.5 -translate-x-1/2 cursor-pointer rounded-full border border-accent-contrast bg-accent transition-transform duration-150 before:absolute before:-inset-[17px] before:content-[''] hover:scale-125"
              style={{ left: `${pct}%` }}
            />
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

      {/* legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-low">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-accent-contrast bg-accent" /> native rule
        </span>
        <span className="flex items-center gap-1.5">
          <SunGlyph size={11} /> wake-ramp (will run)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-dashed border-low" /> wake-ramp (skipped) / est. cron
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
