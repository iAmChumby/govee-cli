"use client";

import * as React from "react";

import { Chip, Odometer, StatusDot } from "@/components/ui";

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

function useLatency(): number {
  const [ms, setMs] = React.useState(12);
  React.useEffect(() => {
    const id = setInterval(() => {
      setMs(9 + Math.floor(Math.random() * 8));
    }, 2000);
    return () => clearInterval(id);
  }, []);
  return ms;
}

/**
 * Bottom status strip: sidecar health, mock badge, API latency,
 * rate-limit hint, ticking mono clock. Sits in the app frame's footer
 * row (the frame reserves its height — no fixed positioning).
 */
export function StatusStrip() {
  const time = useClock();
  const latency = useLatency();

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-hairline bg-bg px-4 font-mono text-[11px] text-low">
      <span className="flex items-center gap-2">
        <StatusDot tone="ok" />
        sidecar :6057
      </span>

      <Chip>mock</Chip>

      <span className="hidden items-baseline gap-1.5 sm:flex">
        <Odometer value={latency} pad={2} suffix="ms" />
      </span>

      <span className="flex-1" />

      <span className="hidden md:inline">budget ~2 req/s</span>
      <span aria-hidden className="hidden h-3 w-px bg-hairline md:block" />
      <span className="tabular-nums">{time}</span>
    </footer>
  );
}
