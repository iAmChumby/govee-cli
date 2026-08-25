"use client";

/**
 * The honest dual preview (§5.5): two synchronized renderers.
 *
 *  - CanvasPreview  — full resolution, one color per physical LED cell,
 *    exactly as drawn. Static by default; the "artist's intent" toggle
 *    animates it smoothly through the motion descriptor so the *intended*
 *    motion is visible somewhere — clearly labeled as not what the device
 *    will do.
 *  - HardwarePreview — every cell recolored to its assigned segment's
 *    gamma-correct downsampled color, visibly blocky/banded. This is what
 *    the lamp can actually render. Its animation loop is throttled to the
 *    same `exportFps` the hardware will actually run at (e.g. 2fps stepped
 *    for H6022 cloud), never a smooth 60fps tween — honesty extends to
 *    time, not just color.
 *
 * The calibration banner ("approximate mapping — calibrate for accuracy")
 * renders whenever `GET /segment-calibration` says `calibrated: false` —
 * the single most important honesty mechanism in the studio (§5.3): it
 * turns an unverifiable boundary guess into an honest, visible caveat
 * instead of a silently-wrong assumption baked into the code.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/cn";
import { Chip } from "@/components/ui/chip";
import { useSegmentCalibration } from "@/lib/queries";
import {
  applyMotion,
  aspectRatioCss,
  downsampleFrame,
  frameCountFor,
  segmentBoundaries,
  totalLeds,
  type Geometry,
  type Motion,
  type Rgb,
} from "./device-geometry";

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

function canvasToHexes(canvas: Uint8ClampedArray): string[] {
  const out: string[] = new Array(canvas.length / 3);
  for (let i = 0; i < out.length; i += 1) {
    const o = i * 3;
    out[i] = toHex([canvas[o], canvas[o + 1], canvas[o + 2]]);
  }
  return out;
}

/** Expands per-segment downsampled colors back onto every cell that
 *  segment covers, for the blocky hardware-preview render. */
function expandBoundaryColors(geometry: Geometry, boundaries: number[], colors: Rgb[]): string[] {
  const out = new Array<string>(totalLeds(geometry)).fill("#000000");
  for (let seg = 0; seg < colors.length; seg += 1) {
    const hex = toHex(colors[seg]);
    for (let led = boundaries[seg]; led < boundaries[seg + 1]; led += 1) out[led] = hex;
  }
  return out;
}

/** Cheap, JS-interval frame stepper (not a `requestAnimationFrame` loop —
 *  this drives a discrete step count, at most a few fps, not a compositor
 *  animation) that respects `prefers-reduced-motion` by holding frame 0. */
function useSteppedFrame(frameCount: number, fps: number, enabled: boolean): number {
  const reduced = useReducedMotion();
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    setFrame(0);
    if (!enabled || reduced || frameCount <= 1 || fps <= 0) return undefined;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frameCount);
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [enabled, reduced, frameCount, fps]);

  return reduced ? 0 : frame;
}

interface GridProps {
  geometry: Geometry;
  colors: readonly string[];
  className?: string;
}

function StaticGrid({ geometry, colors, className }: GridProps) {
  return (
    <div
      aria-hidden
      className={cn("grid overflow-hidden rounded-card border border-hairline-strong", className)}
      style={{
        aspectRatio: aspectRatioCss(geometry),
        gridTemplateColumns: `repeat(${geometry.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${geometry.rows}, minmax(0, 1fr))`,
      }}
    >
      {colors.map((hex, i) => (
        <div key={i} className="border-[0.5px] border-hairline" style={{ backgroundColor: hex }} />
      ))}
    </div>
  );
}

export interface DualPreviewProps {
  refId: string;
  geometry: Geometry;
  /** the painted, unshifted canvas — the artist's source art */
  canvas: Uint8ClampedArray;
  motion: Motion;
  exportFps: number;
  segmentCount: number;
  className?: string;
}

const INTENT_FPS = 24;

export function DualPreview({
  refId,
  geometry,
  canvas,
  motion,
  exportFps,
  segmentCount,
  className,
}: DualPreviewProps) {
  const calibration = useSegmentCalibration(refId);
  const [showIntent, setShowIntent] = React.useState(false);

  const boundaries = React.useMemo(
    () =>
      segmentBoundaries(totalLeds(geometry), segmentCount, {
        boundaries: calibration.data?.boundaries ?? null,
        permutation: calibration.data?.permutation ?? null,
      }),
    [geometry, segmentCount, calibration.data],
  );

  const hwFrameCount = frameCountFor(motion, exportFps);
  const hwFrameIndex = useSteppedFrame(hwFrameCount, exportFps, motion.type !== "static");

  const intentFrameCount = frameCountFor(motion, INTENT_FPS);
  const intentFrameIndex = useSteppedFrame(intentFrameCount, INTENT_FPS, showIntent && motion.type !== "static");

  const hwFrame = React.useMemo(
    () => applyMotion(canvas, geometry, motion, hwFrameIndex, exportFps),
    [canvas, geometry, motion, hwFrameIndex, exportFps],
  );
  const intentFrame = React.useMemo(
    () =>
      showIntent
        ? applyMotion(canvas, geometry, motion, intentFrameIndex, INTENT_FPS)
        : canvas,
    [showIntent, canvas, geometry, motion, intentFrameIndex],
  );

  const canvasColors = React.useMemo(() => canvasToHexes(intentFrame), [intentFrame]);
  // Permutation reindexes by *physical segment id*, which only matters for
  // which zone gets which color over the wire at export time (§5.6) — it
  // doesn't change which LEDs are grouped into one flat-colored block here,
  // so this render (unlike the exporter) only needs the boundary grouping.
  const hardwareColors = React.useMemo(
    () => expandBoundaryColors(geometry, boundaries, downsampleFrame(hwFrame, boundaries)),
    [hwFrame, boundaries, geometry],
  );

  const calibrated = calibration.data?.calibrated ?? false;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-micro text-low">
              canvas · full resolution
            </span>
            <button
              type="button"
              aria-pressed={showIntent}
              onClick={() => setShowIntent((v) => !v)}
              className={cn(
                "rounded-btn border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] transition-colors duration-150",
                showIntent
                  ? "border-hairline-strong bg-accent-dim text-hi"
                  : "border-hairline text-low hover:text-mid",
              )}
            >
              artist&rsquo;s intent {showIntent ? "on" : "off"}
            </button>
          </div>
          <StaticGrid geometry={geometry} colors={canvasColors} />
          <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-low">
            {showIntent
              ? `smooth preview at ${INTENT_FPS}fps — not what the device will do.`
              : "exactly as drawn, unquantized."}
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-micro text-low">
              hardware · {segmentCount} segments
            </span>
            <Chip tone="neutral">{exportFps}fps</Chip>
          </div>
          <StaticGrid geometry={geometry} colors={hardwareColors} />
          <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-low">
            what the lamp actually renders — stepped at the real playback rate.
          </p>
        </div>
      </div>

      {!calibration.isLoading && !calibrated ? (
        <div className="flex items-start gap-2.5 rounded-card border border-ember/30 bg-ember/[0.06] px-3 py-2.5">
          <AlertTriangle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ember" aria-hidden />
          <p className="font-mono text-[10px] leading-relaxed text-ember">
            approximate mapping — the segment boundaries above are an unverified
            hypothesis, not a measured fact. Calibrate for accuracy.
          </p>
        </div>
      ) : null}
    </div>
  );
}
