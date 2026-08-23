import * as React from "react";

import { cn } from "@/lib/cn";

export interface SpinnerProps {
  className?: string;
  /** accessible label when used outside an aria-busy context */
  label?: string;
}

/**
 * Tiny inline spinner (12px) — used sparingly inside buttons during
 * pending mutations. Global CSS renders it static under reduced motion.
 */
export function Spinner({ className, label }: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80",
        className,
      )}
    />
  );
}
