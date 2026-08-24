"use client";

import * as React from "react";

import { cn } from "@/lib/cn";

/** Shared input chrome — dark-neutral raised fill, hairline border. */
export const INPUT_CLASS =
  "h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-[13px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none";

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
