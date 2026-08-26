"use client";

import * as React from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
} from "motion/react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import {
  KEY_COMMIT_COALESCE_MS,
  POINTER_SAFETY_NET_MS,
  useGestureCommit,
} from "@/app/device/[ref]/use-trailing-commit";

/** Total sweep of the dial: 270°, gap at the bottom like a real pot. */
const SWEEP = 270;
const START_ANGLE = -135; // degrees; 0 = 12 o'clock

export interface DialProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  /**
   * The "send it" moment — fires once, synchronously, on a clean drag
   * release (pointerup/pointercancel) or once a keyboard/wheel run
   * settles (keyup, or a short fallback timer for wheel input, which has
   * no keyup of its own). Mirrors `Slider`'s `onValueCommit` contract so
   * both instruments give a caller the same guarantee: at most one
   * commit per gesture, not one per `onValueChange` tick. See
   * `use-trailing-commit.ts`'s `createGestureCommit` for the mechanism
   * and exactly what "clean release" covers.
   */
  onValueCommit?: (value: number) => void;
  /** accessible name */
  label: string;
  /** rendered under the center readout ("%", "K") */
  unit?: string;
  /** formats the center readout text */
  format?: (v: number) => string;
  size?: number;
  disabled?: boolean;
  /**
   * Opts the progress arc/indicator into `var(--dev-hue)`-driven color
   * while actively dragging (V3_VISUAL_DIRECTION.md §D/§E — the same
   * "loud only while live" rule already applied to `Slider`). Reverts to
   * neutral `--accent` the instant the drag ends. Default `false`: every
   * existing consumer keeps its neutral arc unconditionally.
   */
  tint?: boolean;
  className?: string;
}

/* ------------------------------------------------------------------
   Geometry helpers (viewBox is 100×100)
   ------------------------------------------------------------------ */
function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: 50 + radius * Math.sin(rad), y: 50 - radius * Math.cos(rad) };
}

/** Round to 3 decimals so SSR and client emit identical strings —
    libm ulp differences between Node and the browser otherwise cause
    hydration mismatches on these attributes. */
function r3(n: number): number {
  return Number(n.toFixed(3));
}

interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
}

const TICKS: Tick[] = Array.from({ length: 28 }, (_, k) => {
  const angle = START_ANGLE + k * 10;
  const major = k % 9 === 0;
  const outer = polar(angle, 48);
  const inner = polar(angle, major ? 42 : 45);
  return {
    x1: r3(outer.x),
    y1: r3(outer.y),
    x2: r3(inner.x),
    y2: r3(inner.y),
    major,
  };
});

// Arc covering the full 270° sweep at r=48 (start/end share y).
const ARC_PATH = (() => {
  const start = polar(START_ANGLE, 48);
  const end = polar(-START_ANGLE, 48);
  return `M ${r3(start.x)} ${r3(start.y)} A 48 48 0 1 1 ${r3(end.x)} ${r3(end.y)}`;
})();

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/* ------------------------------------------------------------------
   Component
   ------------------------------------------------------------------ */
export function Dial({
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  onValueCommit,
  label,
  unit,
  format,
  size = 116,
  disabled = false,
  tint = false,
  className,
}: DialProps) {
  const range = max - min || 1;

  const gesture = useGestureCommit<number>(
    (v) => onValueCommit?.(v),
    { keyCommitDelayMs: KEY_COMMIT_COALESCE_MS, pointerSafetyNetMs: POINTER_SAFETY_NET_MS },
  );

  const valueToT = React.useCallback(
    (v: number) => clamp01((v - min) / range),
    [min, range],
  );
  const tToValue = React.useCallback(
    (t: number) => {
      const raw = min + t * range;
      const snapped = Math.round(raw / step) * step;
      const fixed = Number(snapped.toFixed(5));
      return Math.min(max, Math.max(min, fixed));
    },
    [min, max, range, step],
  );

  const rootRef = React.useRef<HTMLDivElement>(null);
  const draggingRef = React.useRef(false);
  const lastEmittedRef = React.useRef<number>(value);
  // Mirrors draggingRef into render state for the `tint` arc/indicator
  // color — only flips twice per gesture (start/end), so this doesn't
  // reintroduce the per-frame re-render the ref was added to avoid.
  const [dragging, setDragging] = React.useState(false);

  // Raw target fraction; the spring chases it for weighted inertia.
  const tMV = useMotionValue(valueToT(value));
  const tSpring = useSpring(tMV, springStandard);

  // Live readout value derived from the spring (bails out when equal).
  const [display, setDisplay] = React.useState<number>(value);
  useMotionValueEvent(tMV, "change", (t) => setDisplay(tToValue(t)));

  // Follow external/keyboard value changes with a spring.
  const tTarget = valueToT(value);
  React.useEffect(() => {
    if (draggingRef.current) return;
    void animate(tMV, tTarget, springStandard);
  }, [tTarget, tMV]);

  const emit = React.useCallback(
    (t: number) => {
      const v = tToValue(t);
      if (v !== lastEmittedRef.current) {
        lastEmittedRef.current = v;
        onValueChange(v);
        // Feeds the pointer safety net (see `use-trailing-commit.ts`) —
        // a no-op in the ordinary case, since `endDrag` below sends via
        // `commitPointerRelease` and clears this before it could fire.
        gesture.trackPointerMove(v);
      }
    },
    [onValueChange, tToValue, gesture],
  );

  const pointerToT = React.useCallback(
    (clientX: number, clientY: number): number => {
      const el = rootRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      // compass angle: 0 = up, clockwise positive
      let a = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (a < 0) a += 360;
      const d = (a - (START_ANGLE + 360) + 360) % 360; // distance along sweep
      if (d <= SWEEP) return d / SWEEP;
      // dead zone across the bottom gap: snap to nearest end
      return d < (360 + SWEEP) / 2 ? 1 : 0;
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    const t = pointerToT(e.clientX, e.clientY);
    tMV.set(t);
    emit(t);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled) return;
    const t = pointerToT(e.clientX, e.clientY);
    tMV.set(t);
    emit(t);
  };

  const endDrag = () => {
    if (draggingRef.current) {
      // The real release event — sends immediately, no timer. Also
      // clears the pointer safety net `emit` above has been feeding, so
      // a safety-net timer that was still armed can never also fire and
      // send this same gesture's value a second time.
      gesture.commitPointerRelease(lastEmittedRef.current);
    }
    draggingRef.current = false;
    setDragging(false);
  };

  const nudge = React.useCallback(
    (deltaSteps: number) => {
      if (disabled) return;
      const next = Math.min(max, Math.max(min, value + deltaSteps * step));
      lastEmittedRef.current = next;
      onValueChange(next);
      // Buffered, not sent — `onKeyUp` flushes it when the run (a single
      // tap or a held-key auto-repeat) actually ends. See
      // `createGestureCommit`'s doc for why a per-keydown send would
      // reintroduce the drag-storm bug for anyone who holds the key.
      gesture.bufferKeyStep(next);
    },
    [disabled, max, min, onValueChange, step, value, gesture],
  );

  const flushKeyCommit = React.useCallback(() => gesture.flushKeyRun(), [gesture]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        e.preventDefault();
        nudge(big);
        break;
      case "ArrowDown":
      case "ArrowLeft":
        e.preventDefault();
        nudge(-big);
        break;
      case "PageUp":
        e.preventDefault();
        nudge(10 * big);
        break;
      case "PageDown":
        e.preventDefault();
        nudge(-10 * big);
        break;
      case "Home":
        e.preventDefault();
        lastEmittedRef.current = min;
        onValueChange(min);
        gesture.bufferKeyStep(min);
        break;
      case "End":
        e.preventDefault();
        lastEmittedRef.current = max;
        onValueChange(max);
        gesture.bufferKeyStep(max);
        break;
      default:
        break;
    }
  };

  // Wheel adjusts without hijacking page scroll semantics elsewhere.
  const wheelHandlerRef = React.useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    if (disabled) return;
    e.preventDefault();
    nudge(e.deltaY < 0 ? 1 : -1);
  };
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelHandlerRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const rotation = useTransform(tSpring, [0, 1], [START_ANGLE, -START_ANGLE]);

  const readout = format ? format(display) : String(Math.round(display));

  // Loud only while live (§B) — same rule as Slider's fill/thumb: tint the
  // arc/indicator to the device color while actively dragging, neutral
  // --accent the rest of the time so an idle dial stays chassis-quiet.
  const liveStroke =
    tint && dragging
      ? "hsl(var(--dev-hue) var(--dev-sat) var(--dev-light))"
      : "var(--accent)";

  return (
    <div
      ref={rootRef}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={display}
      aria-valuetext={`${readout}${unit ?? ""}`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onKeyUp={flushKeyCommit}
      // Blur is the fallback for a keyboard run that ends by focus
      // leaving rather than a keyup reaching us (alt-tab mid-hold, a
      // click landing elsewhere) — same reasoning as `Slider`'s onBlur.
      onBlur={flushKeyCommit}
      className={cn(
        "relative select-none touch-none",
        disabled
          ? "pointer-events-none opacity-40"
          : "cursor-grab active:cursor-grabbing",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* tick ring + progress arc + knob face */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden
      >
        {/* dim tick ring */}
        {TICKS.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.major ? "var(--hairline-strong)" : "var(--hairline)"}
            strokeWidth={t.major ? 1.4 : 1}
            strokeLinecap="round"
          />
        ))}
        {/* progress arc — accent by default, device-tinted while dragging */}
        <motion.path
          d={ARC_PATH}
          fill="none"
          stroke={liveStroke}
          strokeWidth={1.6}
          strokeLinecap="round"
          style={{ pathLength: tSpring }}
        />
        {/* knurled rim */}
        <circle
          cx={50}
          cy={50}
          r={32.5}
          fill="none"
          stroke="var(--hairline-strong)"
          strokeWidth={3}
          strokeDasharray="1.6 2.53"
        />
        {/* machined face */}
        <circle
          cx={50}
          cy={50}
          r={29}
          fill="var(--raised)"
          stroke="var(--hairline-strong)"
          strokeWidth={1}
        />
      </svg>

      {/* rotating indicator (HTML layer for crisp transforms) */}
      <motion.div
        aria-hidden
        className="absolute inset-0"
        style={{ rotate: rotation }}
      >
        <span
          className="absolute left-1/2 top-[8%] h-[9%] w-[2px] -translate-x-1/2 rounded-full"
          style={{ backgroundColor: liveStroke }}
        />
      </motion.div>

      {/* center readout slot */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-sm leading-none text-hi">
          {readout}
        </span>
        {unit ? (
          <span className="mt-1 text-[9px] uppercase leading-none tracking-micro text-low">
            {unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}
