import * as React from "react";

import { cn } from "@/lib/cn";

type ChipTone = "neutral" | "accent" | "ok" | "warn";

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "border-hairline text-mid",
  accent: "border-hairline-strong bg-accent-dim text-hi",
  ok: "border-sage/40 text-sage bg-sage/[0.08]",
  warn: "border-ember/40 text-ember bg-ember/[0.08]",
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
