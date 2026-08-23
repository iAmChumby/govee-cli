import * as React from "react";

import { cn } from "@/lib/cn";

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** flat = panel surface · raised = one step up (dialogs, popovers) */
  variant?: "flat" | "raised";
}

/**
 * The signature container: a flat hairline-bordered rounded rectangle.
 * No offset rings, no registration marks, no shadows — per the v2
 * "optical" contract the drama lives in content, never in decoration.
 */
export function Panel({
  variant = "flat",
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-panel border border-hairline",
        variant === "raised" ? "bg-raised" : "bg-panel",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
