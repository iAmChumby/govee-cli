"use client";

/**
 * Motion: direction + speed, expanded algorithmically at export time
 * (§5.4). The studio never asks for hand-keyframed motion for the common
 * case — a static painted canvas plus this descriptor becomes real frames
 * on save. Also renders the live "how much does this cost" estimate
 * (§5.8): frame count and a deduped keyframe/request estimate, computed
 * with the exact same pure pipeline (`renderFrames` → `downsampleFrame` →
 * `buildEffectSegments`) the export dialog uses to save, so the number
 * shown here is never a guess that could diverge from what actually ships.
 */

import * as React from "react";
import { Minus, Plus, RotateCw, Waves } from "lucide-react";

import { cn } from "@/lib/cn";
import { Chip } from "@/components/ui/chip";
import { Slider } from "@/components/ui/slider";
import {
  buildEffectSegments,
  defaultBoundaries,
  downsampleFrame,
  frameCountFor,
  renderFrames,
  totalLeds,
  type Geometry,
  type Motion,
  type MotionAxis,
} from "./device-geometry";

type MotionKind = Motion["type"];

const KIND_OPTIONS: { id: MotionKind; label: string }[] = [
  { id: "static", label: "static" },
  { id: "scroll", label: "scroll" },
  { id: "rotate", label: "rotate" },
  { id: "pingpong", label: "ping-pong" },
  { id: "pulse", label: "pulse" },
];

const MIN_PERIOD = 0.5;
const MAX_PERIOD = 20;

function withDefaults(kind: MotionKind, prev: Motion, wrapCol: boolean): Motion {
  if (kind === "static") return { type: "static" };
  if (kind === "pulse") {
    const period = prev.type !== "static" ? prev.periodSeconds : 3;
    return { type: "pulse", periodSeconds: period };
  }
  const axis: MotionAxis = kind === "rotate" ? "col" : prev.type !== "static" && "axis" in prev ? prev.axis : wrapCol ? "col" : "row";
  const sign = prev.type !== "static" && "sign" in prev ? prev.sign : 1;
  const period = prev.type !== "static" ? prev.periodSeconds : 4;
  return { type: kind, axis, sign, periodSeconds: period };
}

export interface MotionControlsProps {
  motion: Motion;
  onChange: (m: Motion) => void;
  geometry: Geometry;
  canvas: Uint8ClampedArray;
  exportFps: number;
  segmentCount: number;
  className?: string;
}

export function MotionControls({
  motion,
  onChange,
  geometry,
  canvas,
  exportFps,
  segmentCount,
  className,
}: MotionControlsProps) {
  const hasAxis = motion.type === "scroll" || motion.type === "rotate" || motion.type === "pingpong";
  const axis = hasAxis ? motion.axis : null;
  const sign = hasAxis ? motion.sign : null;

  const frameCount = frameCountFor(motion, exportFps);

  const estimate = React.useMemo(() => {
    const boundaries = defaultBoundaries(totalLeds(geometry), segmentCount);
    const frames = renderFrames(canvas, geometry, motion, exportFps);
    const bySegment = frames.map((f) => downsampleFrame(f, boundaries));
    const emitted = buildEffectSegments(bySegment, 1000 / exportFps);
    const totalKeyframes = emitted.reduce((sum, seg) => sum + seg.keyframes.length, 0);
    return { totalKeyframes, naive: frames.length * segmentCount };
  }, [canvas, geometry, motion, exportFps, segmentCount]);

  return (
    <div className={cn("space-y-3.5", className)}>
      <div role="group" aria-label="Motion type" className="flex flex-wrap gap-1.5">
        {KIND_OPTIONS.map((opt) => {
          if (opt.id === "rotate" && !geometry.wrapCol) return null;
          const active = motion.type === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(withDefaults(opt.id, motion, geometry.wrapCol))}
              className={cn(
                "h-8 cursor-pointer rounded-btn border px-3 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors duration-150",
                active
                  ? "border-hairline-strong bg-accent-dim text-hi"
                  : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {hasAxis ? (
        <div className="flex flex-wrap items-center gap-4">
          {motion.type !== "rotate" ? (
            <div role="group" aria-label="Axis" className="flex items-center gap-1">
              {(["col", "row"] as MotionAxis[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={axis === a}
                  onClick={() => onChange({ ...motion, axis: a } as Motion)}
                  className={cn(
                    "h-7 cursor-pointer rounded-btn border px-2.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors duration-150",
                    axis === a
                      ? "border-hairline-strong bg-accent-dim text-hi"
                      : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                  )}
                >
                  {a === "col" ? "columns" : "rows"}
                </button>
              ))}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-micro text-low">
              <RotateCw size={12} strokeWidth={1.6} aria-hidden />
              around the drum
            </span>
          )}

          <div role="group" aria-label="Direction" className="flex items-center gap-1">
            {[1, -1].map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sign === s}
                aria-label={s === 1 ? "Forward" : "Reverse"}
                onClick={() => onChange({ ...motion, sign: s as 1 | -1 } as Motion)}
                className={cn(
                  "flex h-7 w-8 cursor-pointer items-center justify-center rounded-btn border transition-colors duration-150",
                  sign === s
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                )}
              >
                {s === 1 ? <Plus size={13} strokeWidth={1.75} aria-hidden /> : <Minus size={13} strokeWidth={1.75} aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {motion.type !== "static" ? (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-micro text-low">
              {motion.type === "pulse" ? <Waves size={12} strokeWidth={1.6} aria-hidden /> : null}
              cycle speed
            </span>
            <span className="font-mono text-[11px] tabular-nums text-mid">
              {motion.periodSeconds.toFixed(1)}s / cycle
            </span>
          </div>
          <div className="mt-2">
            <Slider
              value={motion.periodSeconds}
              min={MIN_PERIOD}
              max={MAX_PERIOD}
              step={0.5}
              ariaLabel="Motion cycle speed, seconds per loop"
              onValueChange={(v) => onChange({ ...motion, periodSeconds: v } as Motion)}
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <Chip>{frameCount} frame{frameCount === 1 ? "" : "s"}</Chip>
        <Chip tone={estimate.totalKeyframes > 200 ? "warn" : "neutral"}>
          {estimate.totalKeyframes} keyframes (deduped)
        </Chip>
        <span className="font-mono text-[9px] text-low">of {estimate.naive} max</span>
      </div>
    </div>
  );
}
