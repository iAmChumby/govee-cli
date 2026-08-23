"use client";

import * as React from "react";
import { motion } from "motion/react";

import { Chip, ThemeToggle } from "@/components/ui";
import { fadeUp } from "@/lib/motion";

/**
 * Top bar shell: lowercase Archivo wordmark (600, tracking −0.02em),
 * tagline micro-label, breadcrumb, refresh cadence chip, theme toggle.
 */
export function TopBar() {
  return (
    <motion.header
      initial="hidden"
      animate="show"
      variants={fadeUp}
      className="flex h-12 shrink-0 items-center gap-4 border-b border-hairline bg-bg px-4"
    >
      {/* wordmark */}
      <div className="flex items-baseline gap-3">
        <span className="flex items-baseline">
          <span className="text-[17px] font-semibold lowercase leading-none tracking-[-0.02em] text-hi">
            filament
          </span>
          <span
            aria-hidden
            className="ml-1 inline-block h-[5px] w-[5px] animate-dot-breathe rounded-full bg-accent"
          />
        </span>
        <span className="hidden text-[11px] uppercase leading-none tracking-micro text-low sm:inline">
          govee control console
        </span>
      </div>

      <span aria-hidden className="hidden h-4 w-px bg-hairline md:block" />

      {/* breadcrumb */}
      <span className="hidden font-mono text-[11px] text-low md:inline">
        console
      </span>

      <div className="flex-1" />

      {/* cadence */}
      <Chip className="hidden sm:inline-flex">poll 10s</Chip>

      <ThemeToggle />
    </motion.header>
  );
}
