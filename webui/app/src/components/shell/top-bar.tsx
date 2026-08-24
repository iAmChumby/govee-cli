"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

import { Chip, ThemeToggle } from "@/components/ui";
import { fadeUp } from "@/lib/motion";

/** Path segment → readable crumb ("device" stays, refs decode). */
function crumbLabel(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Top bar shell — persistent chrome, mounted once in the root layout so it
 * never replays its entrance or resets its state across navigation.
 * Breadcrumbs derive from the pathname; no per-page wiring.
 */
export function TopBar() {
  const pathname = usePathname();
  const crumbs = React.useMemo(() => {
    if (pathname === "/") return [];
    return pathname.split("/").filter(Boolean).map(crumbLabel);
  }, [pathname]);

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
      <span className="hidden items-center gap-2 font-mono text-[11px] text-low md:flex">
        console
        {crumbs.map((crumb) => (
          <React.Fragment key={crumb}>
            <span aria-hidden className="text-hairline-strong">/</span>
            <span className="text-mid">{crumb}</span>
          </React.Fragment>
        ))}
      </span>

      <div className="flex-1" />

      <Chip className="hidden sm:inline-flex">poll 10s</Chip>

      <ThemeToggle />
    </motion.header>
  );
}
