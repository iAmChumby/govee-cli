"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { CalendarClock, Settings, Terminal } from "lucide-react";

import { Chip, ThemeToggle } from "@/components/ui";
import { fadeUp } from "@/lib/motion";
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

      {/* breadcrumb (desktop) */}
      <span className="hidden items-center gap-2 font-mono text-[11px] text-low md:flex">
        console
        {crumbs.map((crumb) => (
          <React.Fragment key={crumb}>
            <span aria-hidden className="text-hairline-strong">/</span>
            <span className="text-mid">{crumb}</span>
          </React.Fragment>
        ))}
      </span>

      {/* icon nav (mobile — the side rail is hidden below md) */}
      <nav aria-label="Primary" className="flex items-center gap-1 md:hidden">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-btn transition-colors duration-150",
                active ? "bg-accent-dim text-hi" : "text-mid hover:bg-accent-dim hover:text-hi",
              )}
            >
              <item.icon size={16} strokeWidth={1.5} aria-hidden />
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <Chip className="hidden sm:inline-flex">poll 10s</Chip>

      <ThemeToggle />
    </motion.header>
  );
}
