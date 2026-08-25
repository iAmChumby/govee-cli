"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Chip, Odometer, StatusDot } from "@/components/ui";
import { useDevices, useHealth, useMeter } from "@/lib/queries";
import { activeHsl } from "@/components/device/device-plate";
import type { ActiveModeKind } from "@/lib/api";
import { computeBudgetReadout, shouldShowBudget, type BudgetReadout as BudgetReadoutValue } from "@/lib/budget";
import { useEdgeScroll, type ScrollEdges } from "@/lib/use-edge-scroll";

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

/** Builds the scrollable region's edge fade from live scroll position,
 *  mirroring `tabs.tsx`'s `edgeMask` (§11.6 T32's contract — three tasks
 *  including this one import `useEdgeScroll`, and this is the same honest
 *  affordance: a static `mask-image` reads identically to clipped content
 *  whether or not there's more to scroll to, which is §11.2 item (1)'s
 *  defect restated. Fading the row's own `--bg` pixels to transparent
 *  rather than layering paint on top keeps this at CHASSIS — no new
 *  colour token, per §G / §11.4. */
function edgeMask(edges: ScrollEdges): string | undefined {
  if (!edges.scrollable) return undefined;
  const left = edges.atStart ? "black 0" : "transparent 0, black 20px";
  const right = edges.atEnd ? "black 100%" : "black calc(100% - 20px), transparent 100%";
  return `linear-gradient(to right, ${left}, ${right})`;
}

/** Shared rendering for the budget's numeric readout (§10 T26), reused by
 *  both the >=md inline position and the two below-md positions (§11.6 T31)
 *  so the three call sites can't drift out of sync with each other. */
function BudgetCount({ budget }: { budget: BudgetReadoutValue }) {
  return (
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
}

/**
 * Bottom status strip: sidecar health, mock badge, measured API latency,
 * rate-limit hint, ticking mono clock. Sits in the app frame's footer row.
 *
 * §11.6 T31: at >=md this renders exactly what it always has — same
 * elements, same `md:flex` reveal thresholds, same flex-1-spacer trick for
 * right-aligning the signal cluster. Below md, everything that used to be
 * `hidden` (native-scheduler dot, latency, the whole budget readout) now
 * renders too, inside a horizontally scrolling region, because §11.2 item
 * (3) is a "no hidden elements" violation, not a deliberate omission —
 * round two argued at length that a 429 is the only rate-limit evidence
 * the cloud gives us, then showed it exclusively on the machine Luke is not
 * holding at 6am. The one thing that must NOT scroll away is a live
 * warning, so the wake-ramp glyph and a rate-limited budget chip are
 * pinned ahead of the scrolling region instead of living inside it.
 */
export function StatusStrip() {
  const time = useClock();
  const health = useHealth();
  const devices = useDevices();
  const meter = useMeter();
  const latency = useLatency(health.isSuccess);
  const isFriOrSat = useIsFriOrSat();
  const { ref: scrollRef, edges } = useEdgeScroll<HTMLDivElement>();
  const mask = edgeMask(edges);

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

  const budget =
    shouldShowBudget(!!health.data?.mock) && meter.data ? computeBudgetReadout(meter.data) : null;
  const wakeRampLabel = "wake-ramp not armed this weekend — it will not fire";

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-hairline bg-bg px-4 font-mono text-[11px] text-low">
      {/* §11.6 T31, rule 1: a warning must never be the thing that scrolled
          off. Everything below lives inside the scrolling region, so the
          two live alerts — the wake-ramp glyph and a rate-limited budget
          chip — are pinned here instead, ahead of it and outside it
          entirely. A strip where the 429 chip is three swipes to the right
          is worse than today's, which at least never claimed to show
          everything. `hidden max-md:flex` (not the reverse) so this group
          contributes nothing at >=md: both alerts already render inline,
          at their original spot, further down — this group exists purely
          to solve the below-md case, and is absent from the tree (not
          merely empty) once the viewport reaches md. */}
      <div className="hidden shrink-0 items-center gap-2 max-md:flex">
        {wakeRampWillSkip ? (
          <AlertTriangle
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-ember"
            aria-label={wakeRampLabel}
          />
        ) : null}
        {budget?.tone === "warn" ? (
          <Chip tone="warn" title="rate-limited by the cloud today">
            <BudgetCount budget={budget} />
          </Chip>
        ) : null}
      </div>

      {/* The scrolling region itself. `overflow-x-auto` is gated behind
          `max-md:` (§11.1's permitted-mechanism list) rather than left
          unconditional — at >=md this row's content already fits the way
          it does today, so an ungated `overflow-x-auto` would very likely
          never actually scroll there either, but gating it removes that
          "very likely" and makes desktop inertness structural instead of
          incidental. `min-w-0` overrides the flex item's default
          min-width:auto, which would otherwise stop the row from ever
          shrinking below its content's natural width and defeat the
          scroll entirely below md. */}
      <div
        ref={scrollRef}
        data-scroll-affordance={edges.scrollable ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-4 max-md:overflow-x-auto max-md:scrollbar-none"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <span className="flex shrink-0 items-center gap-2">
          <StatusDot tone={health.isError ? "warn" : "ok"} />
          sidecar :6057
        </span>

        {health.data?.mock ? <Chip className="shrink-0">mock</Chip> : null}

        {/* Native-scheduler dot: identical to today at >=md (moved from
            `sm:flex` to `md:flex` — inert for the 1440px gate, since
            anything visible from `sm` up is also visible from `md` up;
            the only effect is closing the 640–767px band where this and
            its new max-md: counterpart below would otherwise both render
            at once). The wake-ramp glyph stays inline here too, exactly
            as before — it only moves to the pinned group below md. */}
        {scheduler ? (
          <span className="hidden shrink-0 items-center gap-1.5 md:flex">
            <StatusDot tone={scheduler.native.alive ? "ok" : "warn"} /> native scheduler
            {wakeRampWillSkip ? (
              <span title={wakeRampLabel}>
                <AlertTriangle size={11} strokeWidth={1.75} className="text-ember" aria-hidden />
              </span>
            ) : null}
          </span>
        ) : null}
        {/* Below-md counterpart (§11.2 item 3): the dot and its label only
            — no wake-ramp glyph here, that lives in the pinned group so a
            warning can never be the thing that scrolls off. */}
        {scheduler ? (
          <span className="flex shrink-0 items-center gap-1.5 md:hidden">
            <StatusDot tone={scheduler.native.alive ? "ok" : "warn"} /> native scheduler
          </span>
        ) : null}

        {/* data-volatile: this readout and the clock below are the only two
            things in the app whose rendered width changes between two
            captures of identical code ("7 ms" vs "127 ms"), so
            scripts/viewport_audit.py excludes them from its
            desktop-invariance diff rather than reporting the tick as a
            layout regression. Both the >=md and below-md renders of the
            latency readout carry the attribute, since each is what its
            respective audit width (1440 / 390) actually measures. */}
        <span data-volatile="true" className="hidden shrink-0 items-baseline gap-1.5 md:flex">
          {latency !== null ? <Odometer value={latency} pad={2} suffix="ms" /> : "— ms"}
        </span>
        <span data-volatile="true" className="flex shrink-0 items-baseline gap-1.5 md:hidden">
          {latency !== null ? <Odometer value={latency} pad={2} suffix="ms" /> : "— ms"}
        </span>

        {/* Below `md` only: the top bar had to give this up to fit the 44px
            nav links at 390px (see top-bar.tsx). It is a cadence fact and
            this strip already carries every other cadence/health fact, so it
            lands here rather than being dropped. The wrapper carries the
            visibility because `Chip`'s own base `inline-flex` would otherwise
            fight a `hidden` class placed on the Chip itself — the exact
            collision that made everyone believe this chip was already hidden
            on phones. At >=md this renders nothing and the top bar's copy is
            the only one. */}
        <span className="flex shrink-0 md:hidden">
          <Chip>poll 10s</Chip>
        </span>

        {/* The spacer that pushes the signal cluster (active-mode chip,
            budget, clock) to the strip's right edge at >=md. Hidden below
            md on purpose: below md there is no left/right split, only a
            single left-to-right scroll order, and an empty flex-1 span
            inside an already-overflowing row has nothing meaningful to
            push against. */}
        <span className="hidden md:block md:flex-1" />

        {mostRecentActive ? (
          <Chip
            tone="signal"
            className="shrink-0"
            style={
              {
                "--dev-hue": activeHsl(mostRecentActive)[0],
                "--dev-sat": `${activeHsl(mostRecentActive)[1]}%`,
                "--dev-light": `${activeHsl(mostRecentActive)[2]}%`,
              } as React.CSSProperties
            }
          >
            {/* Name what is playing and where. "1 light active-mode'd" was
                accurate and told the reader nothing — the useful facts are
                which lamp and which scene, with a count only when there
                are others. */}
            {mostRecentActive.name}
            {mostRecentActive.active.label ? ` · ${mostRecentActive.active.label}` : ""}
            {activeModeDevices.length > 1 ? ` +${activeModeDevices.length - 1}` : ""}
          </Chip>
        ) : null}

        {budget ? (
          <>
            {/* >=md: byte-identical to today, warn chip included inline. */}
            <span className="hidden items-baseline gap-1.5 md:flex">
              {budget.tone === "warn" ? (
                <Chip tone="warn" title="rate-limited by the cloud today">
                  <BudgetCount budget={budget} />
                </Chip>
              ) : (
                <BudgetCount budget={budget} />
              )}
            </span>
            {/* Below md, non-warn only: the warn variant already rendered
                in the pinned group above, and showing the count twice
                would just be confusing, not more informative. */}
            {budget.tone !== "warn" ? (
              <span className="flex shrink-0 items-baseline gap-1.5 md:hidden">
                <BudgetCount budget={budget} />
              </span>
            ) : null}
          </>
        ) : null}

        <span aria-hidden className="hidden h-3 w-px shrink-0 bg-hairline md:block" />
        {/* Least important item on the strip (§11.6 T31, rule 2) — it
            scrolls with everything else below md instead of staying
            pinned at the far right the way `flex-1` keeps it there today. */}
        <span data-volatile="true" className="shrink-0 tabular-nums">
          {time}
        </span>
      </div>
    </footer>
  );
}
