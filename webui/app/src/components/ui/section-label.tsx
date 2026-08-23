import * as React from "react";

import { cn } from "@/lib/cn";

export interface SectionLabelProps {
  /** mono index rendered zero-padded ("01") — omit for rule-only labels */
  index?: string | number;
  title: string;
  className?: string;
}

/**
 * "01 — POWER" micro-label: mono index, uppercase Archivo at 11px
 * with 0.14em tracking in text-mid, trailing hairline rule.
 */
export function SectionLabel({ index, title, className }: SectionLabelProps) {
  return (
    <div className={cn("flex select-none items-center gap-2", className)}>
      {index !== undefined ? (
        <>
          <span className="font-mono text-[10px] leading-none text-low">
            {String(index).padStart(2, "0")}
          </span>
          <span aria-hidden className="text-[10px] leading-none text-low">
            —
          </span>
        </>
      ) : null}
      <span className="text-[11px] uppercase leading-none tracking-micro text-mid">
        {title}
      </span>
      <span aria-hidden className="h-px flex-1 bg-hairline" />
    </div>
  );
}
