"use client";

import * as React from "react";
import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import { Spinner } from "@/components/ui/spinner";

type ButtonVariant = "solid" | "ghost" | "danger";
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
   both flip automatically through the token pair. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  solid:
    "border-transparent bg-accent text-accent-contrast hover:bg-accent-press active:bg-accent-press",
  ghost:
    "border-hairline bg-transparent text-mid hover:border-hairline-strong hover:text-hi hover:bg-accent-dim",
  danger:
    "border-transparent bg-ember text-ember-contrast hover:bg-ember-press active:bg-ember-press",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[10px]",
  md: "h-9 px-4 text-[11px]",
  lg: "h-10 px-5 text-xs",
};

/**
 * Optical-bench button: uppercase Archivo micro-label, hairline or
 * solid accent fills, press scales to 0.97 on a standard spring.
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
    return (
      <motion.button
        ref={ref}
        type="button"
        disabled={busy || disabled}
        whileTap={disabled || busy ? undefined : { scale: 0.97 }}
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
