"use client";

import * as React from "react";
import {
  animate,
  motion,
  useMotionTemplate,
  useSpring,
} from "motion/react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";

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
  className,
}: SliderProps) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? min);
  const current = isControlled ? (value as number) : internal;
  // Bubbles must show during touch drags (no hover), so track active drag.
  const [dragging, setDragging] = React.useState(false);

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
        {/* spring-driven accent fill */}
        <motion.div
          className="absolute left-0 h-full rounded-full bg-accent"
          style={{ width: fillWidthStyle }}
        />
      </SliderPrimitive.Track>

      {/* thumb */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        asChild
        className="block cursor-grab outline-none active:cursor-grabbing"
      >
        <motion.span
          whileTap={{ scale: 1.12 }}
          transition={springStandard}
          className="group relative block h-5 w-5 rounded-full border border-hairline-strong bg-raised transition-colors duration-150 hover:border-accent focus-visible:border-accent"
        >
          <span className="absolute inset-[6px] rounded-full bg-accent" />
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
        </motion.span>
      </SliderPrimitive.Thumb>
    </SliderPrimitive.Root>
  );
}
