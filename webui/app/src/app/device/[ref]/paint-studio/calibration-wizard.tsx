"use client";

/**
 * §5.3 — the paint studio's honesty mechanism. The default segment→matrix
 * boundary guess (`defaultBoundaries()`, §5.2) is a defensible hypothesis,
 * not a verified fact, until this wizard has actually run against the
 * physical device: it paints `segmentCount` maximally-distinct reference
 * hues onto the default boundary guess, applies them live to the lamp one
 * segment at a time (client-throttled — this is a deliberate, rare, opt-in
 * action against real hardware, not something the rest of the studio ever
 * does unprompted), then has the user reorder a strip of reference chips
 * to match what they actually see lit, top-to-bottom, on the real lamp.
 *
 * Reordering here is move-up/move-down controls rather than literal
 * pointer-drag — every step stays reachable with a screen reader or a
 * thumb, and a 15-item strip has no real ergonomic loss from not being
 * draggable (§5.7's touch-target and honesty priorities both point the
 * same way here).
 *
 * What gets saved: `permutation[i]` = which physical segment id the user
 * placed at raster position `i` — the wizard calibrates *segment order*,
 * the part a chip strip can actually verify. `boundaries` are saved as
 * the same default raster split (§5.2) `downsampleFrame()` already uses;
 * per-LED boundary *shape* calibration would need a finer-grained capture
 * than a 15-chip reorder can honestly provide, so this wizard doesn't
 * claim to do it.
 */

import * as React from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { useSegmentCalibration } from "@/lib/queries";
import { useToast } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { defaultBoundaries, totalLeds, type Geometry } from "./device-geometry";

function referenceHex(index: number, count: number): string {
  const hue = (360 * index) / count;
  const h = hue / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [1, x, 0];
  else if (h < 2) [r, g, b] = [x, 1, 0];
  else if (h < 3) [r, g, b] = [0, 1, x];
  else if (h < 4) [r, g, b] = [0, x, 1];
  else if (h < 5) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  const to255 = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`.toUpperCase();
}

type Step = "intro" | "applying" | "reorder" | "saving";

export interface CalibrationWizardProps {
  refId: string;
  geometry: Geometry;
  segmentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const APPLY_GAP_MS = 650; // ~1.5 req/s ceiling for this deliberate, rare wizard action

export function CalibrationWizard({ refId, geometry, segmentCount, open, onOpenChange }: CalibrationWizardProps) {
  const calibration = useSegmentCalibration(refId);
  const { toast } = useToast();

  const [step, setStep] = React.useState<Step>("intro");
  const [applyProgress, setApplyProgress] = React.useState(0);
  const [order, setOrder] = React.useState<number[]>(() =>
    Array.from({ length: segmentCount }, (_, i) => i),
  );

  React.useEffect(() => {
    if (!open) {
      setStep("intro");
      setApplyProgress(0);
      setOrder(Array.from({ length: segmentCount }, (_, i) => i));
    }
  }, [open, segmentCount]);

  const runReferencePattern = async () => {
    setStep("applying");
    for (let i = 0; i < segmentCount; i += 1) {
      try {
        await api.setSegments(refId, { segments: [i], hex: referenceHex(i, segmentCount) });
      } catch (err) {
        toast({
          variant: "error",
          title: "Calibration pattern failed",
          description: err instanceof Error ? err.message : String(err),
        });
        setStep("intro");
        return;
      }
      setApplyProgress(i + 1);
      if (i < segmentCount - 1) await new Promise((r) => setTimeout(r, APPLY_GAP_MS));
    }
    setStep("reorder");
  };

  const move = (from: number, delta: number) => {
    setOrder((prev) => {
      const to = from + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  };

  const save = async () => {
    setStep("saving");
    try {
      await calibration.save({
        boundaries: defaultBoundaries(totalLeds(geometry), segmentCount),
        permutation: order,
      });
      onOpenChange(false);
    } catch {
      // toast already surfaced by useSegmentCalibration's mutation
      setStep("reorder");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogTitle>Calibrate segments</DialogTitle>
        <DialogDescription>
          {step === "intro" &&
            `Sends ${segmentCount} distinct reference colors to the lamp, one segment at a time — keep it in view. Takes about ${Math.round((segmentCount * APPLY_GAP_MS) / 1000)}s.`}
          {step === "applying" && "Sending reference colors to the physical lamp…"}
          {step === "reorder" &&
            "Reorder the chips to match the order you actually see these colors lit, scanning top-to-bottom on the lamp."}
          {step === "saving" && "Saving…"}
        </DialogDescription>

        {step === "intro" ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-start gap-2.5 rounded-card border border-hairline bg-raised px-3 py-2.5">
              <AlertTriangle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-low" aria-hidden />
              <p className="font-mono text-[10px] leading-relaxed text-low">
                This changes what the lamp shows right now. Nothing else in the paint
                studio touches the device without an explicit action.
              </p>
            </div>
            <Button variant="solid" size="sm" onClick={() => void runReferencePattern()}>
              start
            </Button>
          </div>
        ) : null}

        {step === "applying" ? (
          <div className="mt-4 flex items-center gap-3">
            <Loader2 size={16} strokeWidth={2} className="animate-spin text-mid" aria-hidden />
            <span className="font-mono text-[11px] text-mid">
              segment {applyProgress} of {segmentCount}
            </span>
          </div>
        ) : null}

        {step === "reorder" || step === "saving" ? (
          <div className="mt-4 space-y-3">
            <ul className="max-h-[300px] space-y-1.5 overflow-y-auto" aria-label="Segment order">
              {order.map((segId, position) => (
                <li
                  key={segId}
                  className="flex items-center gap-2.5 rounded-card border border-hairline bg-raised px-2.5 py-1.5"
                >
                  <span
                    aria-hidden
                    className="h-6 w-6 shrink-0 rounded-chip border border-hairline-strong"
                    style={{ background: referenceHex(segId, segmentCount) }}
                  />
                  <span className="flex-1 font-mono text-[11px] text-mid">
                    position {position} · segment {segId}
                  </span>
                  <button
                    type="button"
                    aria-label={`Move segment ${segId} up`}
                    disabled={position === 0 || step === "saving"}
                    onClick={() => move(position, -1)}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-btn border border-hairline text-mid transition-colors duration-150 hover:border-hairline-strong hover:text-hi disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ChevronUp size={13} strokeWidth={1.75} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move segment ${segId} down`}
                    disabled={position === order.length - 1 || step === "saving"}
                    onClick={() => move(position, 1)}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-btn border border-hairline text-mid transition-colors duration-150 hover:border-hairline-strong hover:text-hi disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void runReferencePattern()}>
                re-send pattern
              </Button>
              <Button
                variant="solid"
                size="sm"
                className="ml-auto"
                busy={step === "saving"}
                onClick={() => void save()}
              >
                save calibration
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
