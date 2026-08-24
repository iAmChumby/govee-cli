"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface ConfirmDeleteButtonProps {
  /** invoked only after the user confirms inside the arming window */
  onConfirm: () => void;
  /** accessible name for the armed-idle trash state */
  label: string;
  /** text shown while armed */
  confirmText?: string;
  /** ms before the armed state disarms itself */
  armMs?: number;
}

/**
 * Two-step delete: trash click arms a danger "confirm?" state that
 * disarms itself after 3s (or on blur). One DOM node throughout, so
 * keyboard focus survives the morph. No window.confirm anywhere.
 */
export function ConfirmDeleteButton({
  onConfirm,
  label,
  confirmText = "confirm?",
  armMs = 3000,
}: ConfirmDeleteButtonProps) {
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), armMs);
    return () => window.clearTimeout(id);
  }, [armed, armMs]);

  return (
    <Button
      size="sm"
      variant={armed ? "danger" : "ghost"}
      aria-label={armed ? `Confirm: ${label}` : label}
      title={armed ? undefined : label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      className={cn("shrink-0 justify-center", armed ? "px-2.5" : "w-7 px-0")}
    >
      {armed ? confirmText : <Trash2 size={13} strokeWidth={1.5} aria-hidden />}
    </Button>
  );
}
