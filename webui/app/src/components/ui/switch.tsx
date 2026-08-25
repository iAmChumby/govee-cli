"use client";

import * as React from "react";
import { animate, motion, useSpring, useTransform } from "motion/react";

import { cn } from "@/lib/cn";
import { springCelebrate, springStandard } from "@/lib/motion";

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
  /**
   * Opts the "on" fill into `var(--dev-hue)`-driven color instead of the
   * neutral accent gradient, and upgrades the flip itself to one
   * `springCelebrate` overshoot instead of `springStandard` — a switch
   * that visibly "kicks" on the way a real illuminated rocker switch does,
   * then settles (V3_VISUAL_DIRECTION.md §D). Default `undefined`/`false`:
   * every existing switch (settings toggles, future generic uses) keeps
   * its neutral fill and its current flip physics unconditionally.
   */
  hue?: boolean;
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
  hue = false,
  className,
}: SwitchProps) {
  // `hue` opts the flip itself into the celebration spring — every other
  // (non-device) switch keeps the exact springStandard flip it has today.
  const flipTransition = hue ? springCelebrate : springStandard;
  const glow = useSpring(checked ? 1 : 0, flipTransition);

  React.useEffect(() => {
    void animate(glow, checked ? 1 : 0, flipTransition);
  }, [checked, glow, flipTransition]);

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
      {/* WEBUI_V3_SPEC.md §11.3/T35: measured 48x28 — under 44px tall, on
          "the most-tapped control in the app". Previously the `<button>`
          itself painted the pill (border + bg-raised over its whole
          border-box), so simply growing the button's height would have
          grown padding *and* the background into it — the pill would
          have visibly gotten taller, which is the "ink" §11.1 forbids
          moving. Splitting the interactive box from the visual pill lets
          `pointer-coarse:min-h-11` add invisible hit area above/below a
          track that stays exactly h-7 (28px): the button centers the
          track via flex and, at fine pointer, shrinks to the track's own
          size (no min-height applies), so a mouse sees byte-identical
          geometry. `group`/`group-hover` moves the old direct `hover:`
          rule onto the button (the actual hoverable element now that it
          has no visible chrome of its own) so it still paints on the
          track underneath. */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="group relative inline-flex shrink-0 cursor-pointer items-center justify-center disabled:pointer-events-none disabled:opacity-40 pointer-coarse:min-h-11"
      >
        <span
          className={cn(
            "relative inline-flex h-7 w-12 items-center rounded-full border border-hairline bg-raised transition-colors duration-150 group-hover:border-hairline-strong",
            pending && "border-hairline-strong",
          )}
        >
          {/* fill — opacity rides the registered --glow-alpha; background is
              the neutral accent gradient by default, or device-hue when
              `hue` is set (inline style wins over the class-based gradient
              below only once `background` is actually defined) */}
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full bg-gradient-to-br from-accent to-accent-press [opacity:var(--glow-alpha)]"
            style={{
              ...fillStyle,
              background: hue
                ? "linear-gradient(135deg, hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)), hsl(var(--dev-hue) var(--dev-sat) calc(var(--dev-light) - 14%)))"
                : undefined,
            }}
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
        </span>
      </button>
    </span>
  );
}
