import * as React from "react";

import { cn } from "@/lib/cn";

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** flat = panel surface · raised = one step up (dialogs, popovers) */
  variant?: "flat" | "raised";
  /**
   * Opts into the Chassis/Signal card spill (V3_VISUAL_DIRECTION.md §C) —
   * background/border/ambient-shadow tint driven by the `--dev-*` custom
   * properties a consumer sets on this panel (typically via
   * `useDeviceBleed`, see `lib/device-bleed.ts`). Default `false`: every
   * existing `Panel` consumer (paint studio, dialogs, settings) is
   * unaffected, and a bled panel with no `--dev-*` values set resolves the
   * registered initial values (zero alpha) — a plain flat panel either way.
   */
  bleed?: boolean;
}

/**
 * The signature container: a flat hairline-bordered rounded rectangle.
 * No offset rings, no registration marks, no shadows — per the v2
 * "optical" contract the drama lives in content, never in decoration.
 */
export function Panel({
  variant = "flat",
  bleed = false,
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-panel border border-hairline",
        variant === "raised" ? "bg-raised" : "bg-panel",
        bleed && "dev-bleed",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
