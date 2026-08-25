"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { CalendarClock, Settings, Sofa, Terminal } from "lucide-react";

import { Chip, ThemeToggle } from "@/components/ui";
import { fadeUp, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/cn";

/** Path segment → readable crumb ("device" stays, refs decode). */
function crumbLabel(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const NAV_ITEMS = [
  { href: "/", label: "Console", icon: Terminal },
  { href: "/rooms", label: "Rooms", icon: Sofa },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Top bar shell — persistent chrome, mounted once in the root layout so it
 * never replays its entrance or resets its state across navigation.
 * Breadcrumbs derive from the pathname; no per-page wiring. On narrow
 * screens the breadcrumb yields to icon navigation (the side rail hides).
 */
export function TopBar() {
  const pathname = usePathname();
  const reduced = useReducedMotion();
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
      {/* wordmark. The tagline stays `hidden ... sm:inline` below md per §11.5's
          table: it is static branding duplicated by the "filament" wordmark
          12px to its left, carries no state, and was deliberately left off the
          hidden-elements inventory rather than surfaced. */}
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

      {/* breadcrumb (desktop). Stays `hidden md:flex` per §11.5's table: every
          crumb here is already on screen at mobile widths — each route
          renders its own <h1> and the device console renders a "← console"
          back link above the device name — so hiding this is deduplication,
          not omission. */}
      <span className="hidden items-center gap-2 font-mono text-[11px] text-low md:flex">
        console
        {crumbs.map((crumb) => (
          <React.Fragment key={crumb}>
            <span aria-hidden className="text-hairline-strong">/</span>
            <span className="text-mid">{crumb}</span>
          </React.Fragment>
        ))}
      </span>

      {/* icon nav (mobile — the side rail is hidden below md). Chassis per
          §G — the chip/typography/color tokens are exactly what they were;
          the one change is springSnappy press-in physics on the one
          interactive chrome in the bar (§D "Top bar"), guarded by
          useReducedMotion() the way every other primitive's whileTap is.
          T30: h-11 w-11 (44px) is unconditional, not gated behind
          pointer-coarse: this whole <nav> already carries `md:hidden`, so it
          never renders at any width `--check` measures at 1440x900 — a
          pointer-coarse guard here would be dead weight duplicating a
          condition the parent already enforces, not a desktop-safety
          mechanism. */}
      <nav aria-label="Primary" className="flex items-center gap-1 md:hidden">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <motion.span
              key={item.href}
              className="inline-flex"
              whileTap={reduced ? undefined : { scale: 0.9, transition: springSnappy }}
            >
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-btn transition-colors duration-150",
                  active ? "bg-accent-dim text-hi" : "text-mid hover:bg-accent-dim hover:text-hi",
                )}
              >
                <item.icon size={16} strokeWidth={1.5} aria-hidden />
              </Link>
            </motion.span>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Two corrections live in this one element.
          First, §11.2's inventory listed this chip as hidden below `sm`,
          reading its `hidden sm:inline-flex`. It was not. `Chip` carries a
          base `inline-flex`, `cn()` is a plain join with no tailwind-merge,
          and two `display` utilities of equal specificity are settled by
          Tailwind's emitted rule order rather than by attribute order — so
          the chip rendered at every width, which the pre-change 390px
          screenshots confirm. The `hidden` class was decorative all along.
          Second, it does have to leave the phone, but for a reason the
          inventory never mentioned: this bar does not fit. Growing the four
          nav links from 36px to 44px (§11.3) added 32px to a row that was
          already within a few pixels of 390, and the measured result was the
          whole app frame overflowing by 35px with the ThemeToggle sitting at
          x=381..425 — a control pushed clean off the screen by the change
          meant to make controls easier to hit.
          So the chip is now genuinely mobile-hidden, via a WRAPPER whose
          display nothing else competes for, and the status strip renders it
          below `md` instead. Desktop keeps it exactly here, exactly as it
          looks today. */}
      <span className="hidden md:inline-flex">
        <Chip>poll 10s</Chip>
      </span>

      <ThemeToggle />
    </motion.header>
  );
}
