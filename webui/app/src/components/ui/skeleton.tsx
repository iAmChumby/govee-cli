import * as React from "react";

import { cn } from "@/lib/cn";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** square corners by default; pass rounded-panel etc. to override */
  className?: string;
}

/**
 * Low-alpha breathing placeholder block. No shimmer sweep — the panel
 * breathes open instead (WEBUI_SPEC §5.2 motion rules). Neutral
 * accent-dim fill: quiet in both themes, zero warm tint.
 */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-skeleton-breathe rounded-chip bg-accent-dim",
        className,
      )}
      {...rest}
    />
  );
}
