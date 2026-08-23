"use client";

import * as React from "react";
import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";

type IconButtonSize = "sm" | "md";
type IconButtonVariant = "ghost" | "solid";

export interface IconButtonProps
  extends Omit<HTMLMotionProps<"button">, "children"> {
  /** accessible name — required because the control is icon-only */
  label: string;
  /** native tooltip text; a richer tooltip can take over later */
  tooltip?: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  children?: React.ReactNode;
}

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
};

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  ghost:
    "border-hairline bg-transparent text-mid hover:border-hairline-strong hover:text-hi hover:bg-accent-dim",
  solid:
    "border-transparent bg-accent text-accent-contrast hover:bg-accent-press",
};

/**
 * Square hairline button for utility icons. Tooltip-ready via `tooltip`.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      tooltip,
      size = "md",
      variant = "ghost",
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <motion.button
        ref={ref}
        type="button"
        aria-label={label}
        title={tooltip ?? label}
        disabled={disabled}
        whileTap={disabled ? undefined : { scale: 0.94 }}
        transition={springStandard}
        className={cn(
          "inline-flex cursor-pointer select-none items-center justify-center rounded-btn border transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      >
        {children}
      </motion.button>
    );
  },
);
