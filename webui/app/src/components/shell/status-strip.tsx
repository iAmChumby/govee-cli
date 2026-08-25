"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Chip, Odometer, StatusDot } from "@/components/ui";
import { useDevices, useHealth, useMeter } from "@/lib/queries";
import { activeHsl } from "@/components/device/device-plate";
import type { ActiveModeKind, MeterSnapshot } from "@/lib/api";
import { computeBudgetReadout, shouldShowBudget } from "@/lib/budget";

/** Ledger modes the cloud can never read back above "assumed" (§3.4) — the
 *  set that counts as "this device is doing something the dashboard's
 *  basic controls aren't currently showing." */
const NON_BASIC_MODES: ReadonlySet<ActiveModeKind> = new Set([
  "scene",
  "diy",
  "music",
  "snapshot",
  "segments",
  "effect",
]);

function useClock(): string {
  const [time, setTime] = React.useState("--:--:--");
  React.useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString("en-GB", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

/** Round-trip latency to the sidecar, sampled every few seconds. */
/** Mount-gated so SSR and the first client render agree — day-of-week
 *  changes at most once a day, so a 60s poll is plenty. */
function useIsFriOrSat(): boolean {
  const [value, setValue] = React.useState(false);
  React.useEffect(() => {
    const check = () => {
      const day = new Date().getDay(); // 5 = Fri, 6 = Sat
      setValue(day === 5 || day === 6);
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);
  return value;
}

function useLatency(enabled: boolean): number | null {
  const [ms, setMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const sample = async () => {
      const started = performance.now();
      try {
        await fetch("/api/v1/health", { cache: "no-store" });
        if (!cancelled) setMs(Math.round(performance.now() - started));
      } catch {
        if (!cancelled) setMs(null);
      }
    };

    void sample();
    const id = setInterval(sample, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return ms;
}

/**
 * Bottom status strip: sidecar health, mock badge, measured API latency,
 * rate-limit hint, ticking mono clock. Sits in the app frame's footer row.
 */
export function StatusStrip() {
  const time = useClock();
  const health = useHealth();
  const devices = useDevices();
  const meter = useMeter();
  const latency = useLatency(health.isSuccess);
  const isFriOrSat = useIsFriOrSat();

  // §D "Status strip" — one small Chip when any device is in a non-basic
  // (cloud-unverifiable) ledger mode. Color comes from whichever of those
  // devices was most recently touched (`active.set_at`, newest first) —
  // never an average across devices, which would be exactly the dishonest
  // "muddy purple" §C rules out for multi-device color.
  const activeModeDevices = React.useMemo(
    () => (devices.data ?? []).filter((d) => NON_BASIC_MODES.has(d.active.mode)),
    [devices.data],
  );
  const mostRecentActive = React.useMemo(() => {
    if (activeModeDevices.length === 0) return null;
    return [...activeModeDevices].sort((a, b) => {
      const at = a.active.set_at ? Date.parse(a.active.set_at) : 0;
      const bt = b.active.set_at ? Date.parse(b.active.set_at) : 0;
      return bt - at;
    })[0];
  }, [activeModeDevices]);

  const scheduler = health.data?.scheduler;
  // §6.5: relabeled "native scheduler" (this dot is the sidecar's own poll
  // runner, not the crontab-driven automation external.* describes) — the
  // secondary glyph is the one ambient moment worth surfacing a silent
  // skip: a weekend morning where wake-ramp is known (not merely unread)
  // to be unarmed, so the light will NOT come on.
  const wakeRampWillSkip = isFriOrSat && scheduler?.external.wake_ramp_armed === false;

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-hairline bg-bg px-4 font-mono text-[11px] text-low">
      <span className="flex items-center gap-2">
        <StatusDot tone={health.isError ? "warn" : "ok"} />
        sidecar :6057
      </span>

      {health.data?.mock ? <Chip>mock</Chip> : null}
      {scheduler ? (
        <span className="hidden items-center gap-1.5 sm:flex">
          <StatusDot tone={scheduler.native.alive ? "ok" : "warn"} /> native scheduler
          {wakeRampWillSkip ? (
            <span title="wake-ramp not armed this weekend — it will not fire">
              <AlertTriangle size={11} strokeWidth={1.75} className="text-ember" aria-hidden />
            </span>
          ) : null}
        </span>
      ) : null}

      <span className="hidden items-baseline gap-1.5 sm:flex">
        {latency !== null ? (
          <Odometer value={latency} pad={2} suffix="ms" />
        ) : (
          "— ms"
        )}
      </span>

      <span className="flex-1" />

      {mostRecentActive ? (
        <Chip
          tone="signal"
          style={
            {
              "--dev-hue": activeHsl(mostRecentActive)[0],
              "--dev-sat": `${activeHsl(mostRecentActive)[1]}%`,
              "--dev-light": `${activeHsl(mostRecentActive)[2]}%`,
            } as React.CSSProperties
          }
        >
          {/* Name what is playing and where. "1 light active-mode'd" was
              accurate and told the reader nothing — the useful facts are which
              lamp and which scene, with a count only when there are others. */}
          {mostRecentActive.name}
          {mostRecentActive.active.label ? ` · ${mostRecentActive.active.label}` : ""}
          {activeModeDevices.length > 1 ? ` +${activeModeDevices.length - 1}` : ""}
        </Chip>
      ) : null}

      {shouldShowBudget(!!health.data?.mock) && meter.data ? (
        <BudgetReadout meter={meter.data} />
      ) : null}
      <span aria-hidden className="hidden h-3 w-px bg-hairline md:block" />
      <span className="tabular-nums">{time}</span>
    </footer>
  );
}

/**
 * §10 T26 — replaces the hardcoded `budget ~2 req/s` span with measured
 * counts (§10.2). **Tier: CHASSIS**, with one SIGNAL-SPILL exception
 * mirroring the strip's existing active-mode Chip: neutral mono text and
 * the `Odometer` primitive for the rolling count, no motion, no device
 * hue — the *only* coloured state is `Chip tone="warn"` when
 * `rate_limited_today > 0`, because a 429 is the one piece of real
 * evidence we have. No band, no percentage, and no colour when the user
 * has not set `request_budget_per_day` themselves.
 */
function BudgetReadout({ meter }: { meter: MeterSnapshot }) {
  const budget = computeBudgetReadout(meter);
  const count = (
    <span className="inline-flex items-baseline gap-1">
      <Odometer value={budget.v2Today} /> v2/day
      {budget.percent !== null ? (
        <span className="text-low">
          {" "}
          · {budget.percent}% of {budget.budgetPerDay}
        </span>
      ) : null}
    </span>
  );

  return (
    <span className="hidden items-baseline gap-1.5 md:flex">
      {budget.tone === "warn" ? (
        <Chip tone="warn" title="rate-limited by the cloud today">
          {count}
        </Chip>
      ) : (
        count
      )}
    </span>
  );
}
