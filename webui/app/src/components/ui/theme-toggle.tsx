"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import { MoonGlyph, SunGlyph } from "@/components/ui/glyphs";

type StartViewTransition = (callback: () => void) => { ready: Promise<void> };

/**
 * Theme switch — the signature moment. Morphs sun/moon in place
 * (monochrome, currentColor) and triggers a View Transitions API radial
 * reveal expanding from the button position. Falls back to a soft 250ms
 * crossfade when the API is unavailable; prefers-reduced-motion collapses
 * everything to an instant flip via the global media query.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    const next = isDark ? "light" : "dark";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const doc = document as Document & {
      startViewTransition?: StartViewTransition;
    };

    // Fallback path: soften the flip with a temporary crossfade class.
    if (reduced || typeof doc.startViewTransition !== "function") {
      const root = document.documentElement;
      root.classList.add("theme-crossfade");
      setTheme(next);
      window.setTimeout(() => root.classList.remove("theme-crossfade"), 300);
      return;
    }

    // Center the reveal on the button (keyboard clicks report 0,0).
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = doc.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });

    void transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 520,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mounted ? `Switch to ${isDark ? "light" : "dark"} theme` : "Toggle theme"}
      className={cn(
        "inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-btn border border-hairline text-mid transition-colors duration-150 hover:border-hairline-strong hover:text-hi hover:bg-accent-dim",
        className,
      )}
    >
      <span className="relative block h-4 w-4">
        {mounted ? (
          <AnimatePresence initial={false}>
            <motion.span
              key={isDark ? "moon" : "sun"}
              initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
              transition={springStandard}
              className="absolute inset-0 flex items-center justify-center"
            >
              {isDark ? (
                <MoonGlyph size={16} />
              ) : (
                <SunGlyph size={16} />
              )}
            </motion.span>
          </AnimatePresence>
        ) : (
          <span className="absolute inset-0" />
        )}
      </span>
    </button>
  );
}
