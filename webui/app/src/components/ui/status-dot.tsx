import * as React from "react";

import { cn } from "@/lib/cn";

type StatusTone = "ok" | "warn" | "off";

export interface StatusDotProps {
  tone: StatusTone;
  className?: string;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: "bg-sage animate-dot-breathe",
  warn: "bg-ember animate-dot-breathe",
  off: "bg-low opacity-50",
};

/**
 * Presence dot with a slow breathe (ok/warn). `off` sits still.
 * sage/ember are status semantics only — never chrome decoration.
 */
export function StatusDot({ tone, className }: StatusDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-[7px] w-[7px] shrink-0 rounded-full",
        TONE_CLASSES[tone],
        className,
      )}
    />
  );
}
