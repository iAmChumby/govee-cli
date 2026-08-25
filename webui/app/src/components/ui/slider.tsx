"use client";

import * as React from "react";
import {
  animate,
  motion,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
} from "motion/react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/cn";
import { springSnappy, springStandard } from "@/lib/motion";

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number) => void;
  /** fired when the drag ends / keyboard commit — the "send it" moment */
  onValueCommit?: (value: number) => void;
  /** accessible name for the thumb */
  ariaLabel: string;
  /** mono readout bubble above the thumb (hover/focus/drag) */
  showBubble?: boolean;
  disabled?: boolean;
  /**
   * Opts the fill/thumb into `var(--dev-hue)`-driven color while actively
   * dragging (V3_VISUAL_DIRECTION.md §D) — a real dimmer fader tinted by
   * the channel it drives. Reverts to the neutral `--accent` fill the
   * instant the drag ends, so a settled slider never sits there glowing
   * (§B: quiet when not actively signaling). Default `false`: every
   * existing consumer keeps its neutral fill unconditionally.
   */
  tint?: boolean;
  className?: string;
}

/**
 * Hairline instrument slider. 2px track, accent fill whose width is
 * spring-driven (continuous, never stepped), 18px thumb with an inner
 * dot and optional value bubble. Radix provides drag + keyboard support.
 */
export function Slider({
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  onValueCommit,
  ariaLabel,
  showBubble = false,
  disabled = false,
  tint = false,
  className,
}: SliderProps) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? min);
  const current = isControlled ? (value as number) : internal;
  // Bubbles must show during touch drags (no hover), so track active drag.
  const [dragging, setDragging] = React.useState(false);
  const reduced = useReducedMotion();

  const fraction = (current - min) / (max - min || 1);
  const fillWidth = useSpring(fraction * 100, springStandard);
  const fillWidthStyle = useMotionTemplate`${fillWidth}%`;

  React.useEffect(() => {
    void animate(fillWidth, fraction * 100, springStandard);
  }, [fraction, fillWidth]);

  const handleChange = (values: number[]) => {
    const v = values[0] ?? min;
    if (!isControlled) setInternal(v);
    onValueChange?.(v);
  };

  return (
    <SliderPrimitive.Root
      value={[current]}
      onValueChange={handleChange}
      onValueCommit={(values) => {
        setDragging(false);
        onValueCommit?.(values[0] ?? min);
      }}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onPointerDown={() => setDragging(true)}
      onKeyDown={() => setDragging(false)}
      className={cn(
        "relative flex h-6 w-full touch-none select-none items-center",
        disabled && "opacity-40",
        className,
      )}
    >
      {/* track */}
      <SliderPrimitive.Track className="relative h-[2px] w-full grow rounded-full bg-hairline transition-colors duration-150 hover:bg-hairline-strong">
        {/* spring-driven fill — tints to the live device color while
            dragging (tint + dragging), neutral --accent otherwise */}
        <motion.div
          className="absolute left-0 h-full rounded-full"
          style={{
            width: fillWidthStyle,
            backgroundColor:
              tint && dragging
                ? "hsl(var(--dev-hue) var(--dev-sat) var(--dev-light))"
                : "var(--accent)",
          }}
        />
      </SliderPrimitive.Track>

      {/* thumb — WEBUI_V3_SPEC.md §11.3/T35: the 20px grab area inside a
          24px track is under 44px. The old markup painted the visible
          chip (border, bg-raised, rounded-full) directly on the element
          Radix positions and drags, so growing *that* box would have
          grown the chip itself — the "ink" §11.1 says a hit-area fix may
          not move. Splitting it in two fixes that: the outer
          `motion.span` stays the actual Radix thumb (it receives Radix's
          drag/keyboard handlers and its positioning transform) but is
          now visually empty, sized to its content (20px) at fine pointer
          and floored at `pointer-coarse:min-h-11`/`min-w-11` on touch;
          the inner `span` carries every pixel of the old chip's look —
          including `data-dragging`/`data-tint` and the `.slider-thumb`
          class globals.css keys its drag-glow box-shadow off — at a
          fixed 20px, unconditionally. A
          mouse never evaluates `pointer-coarse:`, so the dragged box's
          size and the track math built on it (`TRAVEL` etc.) are
          unchanged at fine pointer. `group-hover`/`group-focus-visible`
          replace the old direct `hover:`/`focus-visible:` rules so the
          now-invisible outer thumb still paints its state onto the
          visible inner chip, and the value bubble moves inside the inner
          span so its `-top-8` offset stays anchored to the chip's own
          edge rather than drifting outward with the touch padding. */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        asChild
        className="cursor-grab outline-none active:cursor-grabbing"
      >
        <motion.span
          whileTap={reduced ? undefined : { scale: 1.12, transition: springSnappy }}
          transition={springStandard}
          className="group relative flex h-5 w-5 shrink-0 items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          {/* `data-dragging`/`data-tint` stay on the same element as the
              `.slider-thumb` class — globals.css's compound selector
              `.slider-thumb[data-dragging="true"][data-tint="true"]`
              needs all three on one node, and the glow it draws is a
              box-shadow that should hug the 20px chip, not the taller
              touch target around it. */}
          <span
            data-dragging={dragging ? "true" : "false"}
            data-tint={tint ? "true" : "false"}
            className="slider-thumb relative block h-5 w-5 rounded-full border border-hairline-strong bg-raised transition-colors duration-150 group-hover:border-accent group-focus-visible:border-accent"
          >
            <span aria-hidden className="absolute inset-[6px] rounded-full bg-accent" />
            {showBubble ? (
              <span
                className={cn(
                  "pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 rounded-chip border border-hairline bg-raised px-1.5 py-0.5 font-mono text-[10px] leading-none text-hi transition-opacity duration-150",
                  dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                )}
              >
                {Math.round(current)}
              </span>
            ) : null}
          </span>
        </motion.span>
      </SliderPrimitive.Thumb>
    </SliderPrimitive.Root>
  );
}
