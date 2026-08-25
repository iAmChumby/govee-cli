"use client";

/**
 * Matrix Paint Studio — orchestrator (§5). Replaces the old select-
 * segments-then-apply rail (`segments-panel.tsx`, deleted) with a real
 * drawing surface for matrix-capable models (H6022, H6056), gated by
 * `capabilities.matrix_rows > 0` in `control-deck.tsx`'s tab dispatch.
 *
 * Owns: canvas state (`use-paint-canvas.ts`), the motion descriptor, and
 * wiring `canvas-grid.tsx`'s five gesture callbacks to whichever tool is
 * active — the one place tool semantics (brush/fill/gradient/eyedropper)
 * actually live, since `canvas-grid.tsx` itself stays presentational.
 *
 * Layout: canvas + preview + motion controls in the main column; palette/
 * tool controls sit directly beneath the canvas so they're immediately
 * thumb-reachable on a phone without introducing a new non-modal sheet
 * primitive (this codebase's `Dialog` is a modal overlay, out of place for
 * a persistent control tray) — a sidebar column on wider screens instead.
 */

import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";

import type { DeviceState } from "@/lib/api";
import { api } from "@/lib/api";
import { useSegmentCalibration } from "@/lib/queries";
import { useToast } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SectionLabel } from "@/components/ui/section-label";

import { CanvasGrid, type CellHit } from "./canvas-grid";
import { PaletteBar } from "./palette-bar";
import { DualPreview } from "./dual-preview";
import { MotionControls } from "./motion-controls";
import { CalibrationWizard } from "./calibration-wizard";
import { BLE_DEFAULT_FPS, CLOUD_DEFAULT_FPS, ExportDialog } from "./export-dialog";
import { usePaintCanvas } from "./use-paint-canvas";
import {
  applySegmentPermutation,
  aspectRatioCss,
  downsampleFrame,
  segmentBoundaries,
  totalLeds,
  type Geometry,
  type Motion,
  type Rgb,
} from "./device-geometry";
import { floodFill } from "./tools/flood-fill";
import { gradientFill, type GradientPoint } from "./tools/gradient-tool";
import { rgbToHex } from "./tools/eyedropper";

interface PaintStudioPanelProps {
  refId: string;
  state: DeviceState;
}

const PREVIEW_GAP_MS = 1000; // ≤1 req/s, client-side (§5.7)

function hexToRgb(hex: string): Rgb {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0];
}

export function PaintStudioPanel({ refId, state }: PaintStudioPanelProps) {
  const caps = state.capabilities;
  const geometry: Geometry = React.useMemo(
    () => ({
      rows: caps?.matrix_rows ?? 0,
      cols: caps?.matrix_cols ?? 0,
      wrapCol: caps?.matrix_wrap_col ?? false,
    }),
    [caps?.matrix_rows, caps?.matrix_cols, caps?.matrix_wrap_col],
  );

  const paint = usePaintCanvas(geometry);
  const { toast } = useToast();
  const calibration = useSegmentCalibration(refId);

  const [motion, setMotion] = React.useState<Motion>({ type: "static" });
  const [gradientPoint, setGradientPoint] = React.useState<GradientPoint | null>(null);
  const [calibrateOpen, setCalibrateOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<{ active: boolean; index: number; total: number }>({
    active: false,
    index: 0,
    total: 0,
  });
  const previewCancelRef = React.useRef(false);

  const canBle = (caps?.prefer_ble_effects ?? false) && (caps?.segment_count_ble ?? 0) > 0;
  const previewSegmentCount = canBle ? caps?.segment_count_ble ?? 0 : caps?.segment_count_cloud ?? 15;
  const previewExportFps = canBle ? BLE_DEFAULT_FPS : CLOUD_DEFAULT_FPS;

  /* ---------------------------------------------------------- gestures */

  const handleDragStart = (hit: CellHit) => {
    if (paint.tool !== "brush") return;
    paint.beginStroke();
    paint.paintCell(hit.row, hit.col);
  };
  const handleDragMove = (hit: CellHit) => {
    if (paint.tool !== "brush") return;
    paint.paintCell(hit.row, hit.col);
  };
  const handleDragEnd = () => {
    if (paint.tool !== "brush") return;
    paint.endStroke();
  };

  const handleTap = (hit: CellHit) => {
    switch (paint.tool) {
      case "brush":
        paint.beginStroke();
        paint.paintCell(hit.row, hit.col);
        paint.endStroke();
        return;
      case "fill": {
        const diffs = floodFill(paint.canvas, geometry, hit.index, hexToRgb(paint.primaryColor));
        paint.applyDiffs(diffs);
        return;
      }
      case "gradient": {
        if (!gradientPoint) {
          setGradientPoint({ row: hit.row, col: hit.col });
          return;
        }
        const diffs = gradientFill(
          paint.canvas,
          geometry,
          gradientPoint,
          { row: hit.row, col: hit.col },
          hexToRgb(paint.primaryColor),
          hexToRgb(paint.secondaryColor),
        );
        paint.applyDiffs(diffs);
        setGradientPoint(null);
        return;
      }
      case "eyedropper": {
        const rgb = paint.colorAt(hit.row, hit.col);
        paint.setPrimaryColor(rgbToHex(rgb));
        paint.setTool("brush");
        return;
      }
      default:
        return;
    }
  };

  const handleLongPress = (hit: CellHit) => {
    const rgb = paint.colorAt(hit.row, hit.col);
    paint.setPrimaryColor(rgbToHex(rgb));
    paint.setTool("brush");
    setGradientPoint(null);
  };

  /* ---------------------------------------------------- device preview */

  const runPreview = async () => {
    if (preview.active) {
      previewCancelRef.current = true;
      return;
    }
    if (previewSegmentCount <= 0) return;
    const boundaries = segmentBoundaries(totalLeds(geometry), previewSegmentCount, calibration.data ?? null);
    const colors = applySegmentPermutation(
      downsampleFrame(paint.canvas, boundaries),
      calibration.data?.calibrated ? calibration.data.permutation : null,
    );
    previewCancelRef.current = false;
    setPreview({ active: true, index: 0, total: colors.length });
    for (let i = 0; i < colors.length; i += 1) {
      if (previewCancelRef.current) break;
      try {
        await api.setSegments(refId, { segments: [i], hex: rgbToHex(colors[i]) });
      } catch (err) {
        toast({
          variant: "error",
          title: "Device preview failed",
          description: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      setPreview((s) => ({ ...s, index: i + 1 }));
      if (i < colors.length - 1) await new Promise((r) => setTimeout(r, PREVIEW_GAP_MS));
    }
    setPreview({ active: false, index: 0, total: 0 });
  };

  // Hooks above must run unconditionally on every render — the "no matrix"
  // bail-out only ever affects what gets *returned*, never how many hooks
  // this component calls.
  const canvasColors = React.useMemo(() => {
    const out = new Array<string>(totalLeds(geometry));
    for (let i = 0; i < out.length; i += 1) {
      const o = i * 3;
      out[i] = rgbToHex([paint.canvas[o], paint.canvas[o + 1], paint.canvas[o + 2]]);
    }
    return out;
  }, [paint.canvas, geometry]);

  if (geometry.rows <= 0 || geometry.cols <= 0) {
    return (
      <Panel className="mt-5 p-5">
        <p className="text-[12px] text-mid">
          This model has no addressable matrix — paint studio isn&rsquo;t available.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="mt-5 space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel
          index="01"
          title={`${geometry.rows}×${geometry.cols} ${geometry.wrapCol ? "wrapped-cylinder" : "linear"} canvas`}
        />
        <Button variant="ghost" size="sm" onClick={() => setCalibrateOpen(true)}>
          {calibration.data?.calibrated ? "recalibrate" : "calibrate segments"}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-5">
          <CanvasGrid
            geometry={geometry}
            colors={canvasColors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTap={handleTap}
            onLongPress={handleLongPress}
            ariaLabel={`${state.name ?? refId} paint canvas`}
            className="w-full"
            style={{ aspectRatio: aspectRatioCss(geometry) }}
          />

          {paint.tool === "gradient" ? (
            <p className="-mt-3 font-mono text-[10px] text-low">
              {gradientPoint ? "tap the gradient's end point" : "tap the gradient's start point"}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => void runPreview()} disabled={previewSegmentCount <= 0}>
              {preview.active ? (
                <>
                  <Loader2 size={12} strokeWidth={2} className="animate-spin" aria-hidden />
                  cancel ({preview.index}/{preview.total})
                </>
              ) : (
                "preview on device"
              )}
            </Button>
            <span className="font-mono text-[9px] text-low">
              sends the current drawing to the real lamp, one segment/second
            </span>
          </div>

          <div>
            <SectionLabel index="02" title="honest preview" />
            <div className="mt-3">
              <DualPreview
                refId={refId}
                geometry={geometry}
                canvas={paint.canvas}
                motion={motion}
                exportFps={previewExportFps}
                segmentCount={previewSegmentCount}
              />
            </div>
          </div>

          <div>
            <SectionLabel index="03" title="motion" />
            <div className="mt-3">
              <MotionControls
                motion={motion}
                onChange={setMotion}
                geometry={geometry}
                canvas={paint.canvas}
                exportFps={previewExportFps}
                segmentCount={previewSegmentCount}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-hairline pt-4">
            <Button variant="signal" size="sm" className="ml-auto" onClick={() => setExportOpen(true)}>
              <Sparkles size={12} strokeWidth={1.75} aria-hidden />
              save as effect
            </Button>
          </div>
        </div>

        <div className="sm:sticky sm:top-4 sm:self-start">
          <PaletteBar
            tool={paint.tool}
            onToolChange={(t) => {
              paint.setTool(t);
              setGradientPoint(null);
            }}
            primaryColor={paint.primaryColor}
            onPrimaryChange={paint.setPrimaryColor}
            secondaryColor={paint.secondaryColor}
            onSecondaryChange={paint.setSecondaryColor}
            symmetry={paint.symmetry}
            onSymmetryChange={paint.setSymmetry}
            canUndo={paint.canUndo}
            canRedo={paint.canRedo}
            onUndo={paint.undo}
            onRedo={paint.redo}
            onClear={paint.clear}
          />
        </div>
      </div>

      <CalibrationWizard
        refId={refId}
        geometry={geometry}
        segmentCount={caps?.segment_count_cloud ?? 15}
        open={calibrateOpen}
        onOpenChange={setCalibrateOpen}
      />

      <ExportDialog
        refId={refId}
        geometry={geometry}
        canvas={paint.canvas}
        motion={motion}
        capabilities={caps}
        calibration={calibration.data}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
    </Panel>
  );
}
