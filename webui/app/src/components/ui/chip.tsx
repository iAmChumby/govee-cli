import * as React from "react";

import { cn } from "@/lib/cn";

export type ChipTone = "neutral" | "accent" | "ok" | "warn" | "signal";

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

/* `signal` (V3_VISUAL_DIRECTION.md §D, "Status strip") is the one
   SIGNAL-SPILL tone — it fills from `var(--dev-hue)` instead of a fixed
   token, for the rare chip reporting a specific device's live color (e.g.
   the status strip's active-mode aggregate). A consumer that never sets
   the --dev-* quartet on this chip (or an ancestor) gets the registered
   initial values — a flat, unsaturated fill — so an unused `signal` tone
   is never a silent bug. Every pre-existing tone is untouched. */
const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "border-hairline text-mid",
  accent: "border-hairline-strong bg-accent-dim text-hi",
  ok: "border-sage/40 text-sage bg-sage/[0.08]",
  warn: "border-ember/40 text-ember bg-ember/[0.08]",
  signal:
    "border-transparent text-white [background-color:hsl(var(--dev-hue)_var(--dev-sat)_var(--dev-light)_/_0.85)]",
};

/**
 * Tiny hairline chip for model tags, transport tags, badges.
 */
export function Chip({ tone = "neutral", className, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-chip border px-1.5 py-[3px] font-mono text-[10px] uppercase leading-none tracking-[0.08em]",
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    />
  );
}
