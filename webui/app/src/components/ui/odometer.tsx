"use client";

import * as React from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";

export interface OdometerProps {
  value: number;
  /** minimum digit count; grows automatically for larger magnitudes */
  pad?: number;
  /** static suffix rendered after the digits ("%", "ms", "K") */
  suffix?: string;
  className?: string;
}

/**
 * Rolling numeric readout. Each digit is its own spring-driven column
 * (translateY through a 0–9 stack) in fixed-width IBM Plex Mono, so
 * values of any magnitude roll odometer-style instead of snapping.
 */
export function Odometer({
  value,
  pad,
  suffix,
  className,
}: OdometerProps) {
  const negative = value < 0;
  const rounded = Math.round(Math.abs(value));
  const raw = String(rounded);
  const padded = pad !== undefined && raw.length < pad ? raw.padStart(pad, "0") : raw;
  // key columns from the right so growth prepends a new column
  const chars = padded.split("");

  return (
    <span
      className={cn(
        "inline-flex items-baseline font-mono tabular-nums leading-none",
        className,
      )}
    >
      <span className="sr-only">
        {negative ? "-" : ""}
        {raw}
        {suffix ? ` ${suffix}` : ""}
      </span>
      <span aria-hidden className="inline-flex items-baseline">
        {negative ? <span>-</span> : null}
        {chars.map((c, i) => {
          const key = padded.length - 1 - i; // position from right
          if (!/\d/.test(c)) {
            return (
              <span
                key={`sym-${key}`}
                className="inline-block w-[1ch] text-center"
              >
                {c}
              </span>
            );
          }
          return <DigitColumn key={`dig-${key}`} digit={Number(c)} />;
        })}
        {suffix ? <span className="ml-1 text-low">{suffix}</span> : null}
      </span>
    </span>
  );
}

function DigitColumn({ digit }: { digit: number }) {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="relative inline-block h-[1em] w-[1ch] overflow-hidden align-baseline"
    >
      <motion.span
        className="flex flex-col"
        initial={false}
        animate={{ y: `-${digit}em` }}
        transition={springStandard}
      >
        {DIGITS.map((d) => (
          <span key={d} className="flex h-[1em] items-center justify-center">
            {d}
          </span>
        ))}
      </motion.span>
    </motion.span>
  );
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
