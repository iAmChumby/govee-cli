"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Shared input chrome — dark-neutral raised fill, hairline border.
 *
 * §11.3: h-9 is 36px, under the 44px touch-target floor — the same gap
 * `capture-room-dialog.tsx`'s local copy of this class already closed.
 * `pointer-coarse:h-11` grows the laid-out box itself (not an overlay)
 * because these are full-width fields with no siblings beside them to
 * collide with; a mouse never evaluates `pointer-coarse:`, so nothing
 * moves at fine-pointer/desktop widths.
 */
export const INPUT_CLASS =
  "h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-[13px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none pointer-coarse:h-11";

export interface FieldProps {
  /** micro-label rendered above the control */
  label: string;
  /** field-level validation message; announced via role=alert */
  error?: string;
  /** quiet mono hint shown when there is no error */
  hint?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label + control + error slot. Wrapping <label> gives every native
 * control an accessible name without extra ids.
 */
export function Field({ label, error, hint, className, children }: FieldProps) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[11px] uppercase leading-none tracking-micro text-mid">
        {label}
      </span>
      {children}
      {error ? (
        <span role="alert" className="mt-1.5 block font-mono text-[11px] leading-snug text-ember">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block font-mono text-[10px] leading-snug text-low">{hint}</span>
      ) : null}
    </label>
  );
}

/** Definition row used across the settings panels: micro-label ↔ value. */
export function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0 pointer-coarse:items-start">
      <span className="text-[11px] uppercase leading-none tracking-micro text-mid pointer-coarse:shrink-0">
        {label}
      </span>
      {/* §11.2(6): truncate + this row's own values (e.g. the raw crontab
          error under "crontab error") is a hover-only reveal — there is no
          `title` here at all, so on a phone the clipped text was simply
          gone. `min-w-0` is what let `truncate` clip in the first place;
          under pointer:coarse the text wraps onto its own line(s) inside
          the same flex item instead. The label gets `pointer-coarse:shrink-0`
          so it isn't squeezed once the value grows to more than one line —
          gated the same way, since at fine-pointer/desktop widths this row
          already fits on one line and shrinking never triggers regardless. */}
      <span className="min-w-0 truncate font-mono text-[12px] tabular-nums text-mid pointer-coarse:whitespace-normal pointer-coarse:break-words">
        {children}
      </span>
    </div>
  );
}
