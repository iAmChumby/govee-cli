"use client";

import * as React from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";
import { springSnappy, springStandard } from "@/lib/motion";
import { Spinner } from "@/components/ui/spinner";

type ButtonVariant = "solid" | "ghost" | "danger" | "signal";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** shows the inline spinner and disables interaction */
  busy?: boolean;
  children?: React.ReactNode;
}

/* solid = accent fill (white in dark / ink in light) with inverse text;
   both flip automatically through the token pair. `signal` is the one
   SIGNAL-SPILL variant (V3_VISUAL_DIRECTION.md §D) — reserved for buttons
   that commit a device-affecting action from inside an already-colored
   context (paint studio's "apply," the stage's floating "paint N
   segments" button); it inherits `var(--dev-hue)` as its fill instead of
   `--accent`, so it only reads as colored where a card/stage above it has
   actually set the --dev-* quartet — everywhere else it falls back to the
   registered initial values (a flat, unsaturated fill), never introducing
   color of its own. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  solid:
    "border-transparent bg-accent text-accent-contrast hover:bg-accent-press active:bg-accent-press",
  ghost:
    "border-hairline bg-transparent text-mid hover:border-hairline-strong hover:text-hi hover:bg-accent-dim",
  danger:
    "border-transparent bg-ember text-ember-contrast hover:bg-ember-press active:bg-ember-press",
  signal:
    "border-transparent text-white [background-color:hsl(var(--dev-hue)_var(--dev-sat)_var(--dev-light))] hover:brightness-110 active:brightness-95",
};

// WEBUI_V3_SPEC.md §11.3/T35: every size here is under 44px tall (sm 28,
// md 36, lg 40), and an icon-only `sm` button (no text driving its width)
// measured 28x28. `min-h-11`/`min-w-11` under `pointer-coarse:` set a
// *floor* rather than overriding `h-*`/fixed padding — CSS resolves
// height/width against min-height/min-width regardless of which utility
// class comes first in the generated stylesheet, so this can't lose a
// specificity fight the way a second `h-11` class competing with `h-7`
// could. At fine pointer `min-height`/`min-width` are unset (initial 0),
// so the exact px values above still win — the gate at 1440x900 sees
// nothing move. `pointer-coarse:px-4` on `sm` keeps a short label
// (e.g. one glyph) from looking pinched inside its taller box.
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[10px] pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-4",
  md: "h-9 px-4 text-[11px] pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  lg: "h-10 px-5 text-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11",
};

/**
 * Optical-bench button: uppercase Archivo micro-label, hairline or
 * solid accent fills. Press-in rides `springSnappy` — crisper than a
 * value settling, more resistance than a slider drag; release eases back
 * out on `springStandard` so it doesn't feel twitchy
 * (V3_VISUAL_DIRECTION.md §E). Guarded by `useReducedMotion()`: a
 * reduced-motion user gets an instant disabled/enabled state change with
 * no scale transform at all, closing the gap the design doc flagged.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "ghost",
      size = "md",
      busy = false,
      disabled,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const reduced = useReducedMotion();
    const canPress = !(disabled || busy) && !reduced;

    return (
      <motion.button
        ref={ref}
        type="button"
        disabled={busy || disabled}
        whileTap={canPress ? { scale: 0.97, transition: springSnappy } : undefined}
        transition={springStandard}
        aria-busy={busy || undefined}
        className={cn(
          "inline-flex cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-btn border font-medium uppercase tracking-[0.08em] transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      >
        {busy ? <Spinner /> : null}
        {children}
      </motion.button>
    );
  },
);
