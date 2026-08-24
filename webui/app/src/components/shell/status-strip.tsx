"use client";

import * as React from "react";

import { Chip, Odometer, StatusDot } from "@/components/ui";
import { useHealth } from "@/lib/queries";

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
  const latency = useLatency(health.isSuccess);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-hairline bg-bg px-4 font-mono text-[11px] text-low">
      <span className="flex items-center gap-2">
        <StatusDot tone={health.isError ? "warn" : "ok"} />
        sidecar :6057
      </span>

      {health.data?.mock ? <Chip>mock</Chip> : null}
      {health.data?.scheduler ? (
        <span className="hidden items-center gap-1.5 sm:flex">
          <StatusDot tone="ok" /> scheduler
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

      {!health.data?.mock ? <span className="hidden md:inline">budget ~2 req/s</span> : null}
      <span aria-hidden className="hidden h-3 w-px bg-hairline md:block" />
      <span className="tabular-nums">{time}</span>
    </footer>
  );
}
