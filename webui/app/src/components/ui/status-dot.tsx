import * as React from "react";

import { cn } from "@/lib/cn";

type StatusTone = "ok" | "warn" | "off";

export interface StatusDotProps {
  tone: StatusTone;
  className?: string;
  /**
   * Second channel beside colour: an SR-announced state label. When set, a
   * hairline ring wraps the dot and the label is rendered hidden for
   * assistive technology. The dot's 7x7 size, hue and breathe stay
   * unchanged — colour remains the primary signal, the label is the
   * redundancy WCAG 1.4.1 requires.
   */
  label?: string;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: "bg-sage animate-dot-breathe",
  warn: "bg-ember animate-dot-breathe",
  off: "bg-low opacity-50",
};

/**
 * Presence dot with a slow breathe (ok/warn). `off` sits still.
 * sage/ember are status semantics only — never chrome decoration.
 *
 * `label` opts the dot into the second channel: a ring plus a hidden
 * label so the state survives a greyscale check or a screen reader.
 */
export function StatusDot({ tone, label, className }: StatusDotProps) {
  return (
    <span className={cn("inline-block shrink-0", className)}>
      {/* always aria-hidden: the visual dot carries no text, so exposing it
          would announce an unlabelled element; the sr-only span below is the
          accessible channel when a label is given */}
      <span
        aria-hidden
        className={cn(
          "inline-block h-[7px] w-[7px] shrink-0 rounded-full",
          label !== undefined ? "ring-1 ring-inset ring-hairline-strong" : "",
          TONE_CLASSES[tone],
        )}
      />
      {label !== undefined && <span className="sr-only">{label}</span>}
    </span>
  );
}
