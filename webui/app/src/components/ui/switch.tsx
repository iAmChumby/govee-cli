"use client";

import * as React from "react";
import { animate, motion, useSpring, useTransform } from "motion/react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";

const TRACK_W = 48; // px — sized for a comfortable touch target
const THUMB_W = 22; // px
const TRACK_PAD = 3; // px
const TRAVEL = TRACK_W - THUMB_W - TRACK_PAD * 2; // 20px

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** accessible name — the switch carries no visible label of its own */
  ariaLabel: string;
  disabled?: boolean;
  /** true while the last commanded value is still unconfirmed by the device */
  pending?: boolean;
  className?: string;
}

/**
 * Optical-bench toggle: a pill whose ON state fills the track with an
 * accent gradient (white in dark / ink in light) whose opacity is driven
 * through the registered custom property --glow-alpha (see tokens.css),
 * so it interpolates continuously — never a class flip. Thumb travel
 * rides the same spring. While `pending`, a soft halo breathes around the
 * track: the command is in flight and the cloud has not confirmed it yet.
 */
export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled = false,
  pending = false,
  className,
}: SwitchProps) {
  const glow = useSpring(checked ? 1 : 0, springStandard);

  React.useEffect(() => {
    void animate(glow, checked ? 1 : 0, springStandard);
  }, [checked, glow]);

  const thumbX = useTransform(glow, [0, 1], [0, TRAVEL]);
  const fillStyle = {
    "--glow-alpha": glow,
  } as unknown as React.CSSProperties;

  return (
    <span className={cn("relative inline-flex", className)}>
      {/* syncing halo — mounted only while a command is unconfirmed */}
      {pending ? (
        <motion.span
          aria-hidden
          className="absolute -inset-[5px] rounded-full border border-accent/50"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: [0, 0.7, 0.25], scale: [0.9, 1.06, 1] }}
          transition={{
            opacity: { duration: 1.6, repeat: Infinity, ease: "easeInOut" },
            scale: { duration: 1.6, repeat: Infinity, ease: "easeInOut" },
          }}
        />
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-hairline bg-raised transition-colors duration-150 hover:border-hairline-strong disabled:pointer-events-none disabled:opacity-40",
          pending && "border-hairline-strong",
        )}
      >
        {/* accent fill — opacity rides the registered --glow-alpha */}
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full bg-gradient-to-br from-accent to-accent-press [opacity:var(--glow-alpha)]"
          style={fillStyle}
        />
        {/* thumb */}
        <motion.span
          aria-hidden
          className="absolute left-[3px] top-1/2 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-hairline-strong bg-raised"
          style={{ x: thumbX, y: "-50%" }}
        >
          <motion.span
            className="h-1.5 w-1.5 rounded-full bg-accent"
            style={{ opacity: glow }}
          />
        </motion.span>
      </button>
    </span>
  );
}
