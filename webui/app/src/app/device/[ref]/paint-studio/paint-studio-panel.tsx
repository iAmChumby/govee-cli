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
    // `@container` makes this Panel the containment root for the `@3xl`
    // split below. (DualPreview carries its own `@container` so its `@sm`
    // split measures its own slot, not this whole panel — a nested
    // container shadows this one for its own subtree, which is what that
    // query wants.) At `lg` and up this panel lives inside the device
    // page's ~470-520px CSS-px-wide fixed column
    // (`lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]` inside `max-w-[1200px]`
    // in `device/[ref]/page.tsx`), which is narrower than Tailwind's `sm:`
    // viewport breakpoint (640px) — so a `sm:` split here was permanently
    // active on every desktop regardless of how little room this column
    // actually had, squeezing the canvas to ~130px. A container query reads
    // *this element's* rendered width instead of the viewport's, so the
    // studio adapts to its own column.
    <Panel className="mt-5 space-y-5 p-5 @container">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel
          index="01"
          title={`${geometry.rows}×${geometry.cols} ${geometry.wrapCol ? "wrapped-cylinder" : "linear"} canvas`}
        />
        <Button variant="ghost" size="sm" onClick={() => setCalibrateOpen(true)}>
          {calibration.data?.calibrated ? "recalibrate" : "calibrate segments"}
        </Button>
      </div>

      {/* `@3xl` = 768px of CONTAINER content width, and the container is the
          Panel above. Where that actually lands, measured off the real
          chain (page `max-w-[1200px] px-6` -> ControlDeck Panel `sm:px-5`
          -> this Panel's `p-5`), is `viewport - 128`:

            viewport >= 1024  the page grid splits 11fr/9fr, this panel gets
                              ~429px of content -> single column. The old
                              `sm:` fired here and cost the canvas 260px it
                              did not have; that is the bug this fixes.
            896 <= vw < 1024  the page grid is still stacked, so this panel
                              spans ~772px and the split DOES fire: ~492px
                              of canvas beside the 260px palette column.
                              That is the one width band where there is
                              genuinely room for both, and it is live today
                              — not a dormant future branch.
            viewport < 896    single column.

          PaletteBar is `flex-wrap` by its own design contract, so its
          7-button row wrapping to two rows inside 260px is intended
          behaviour in that band, not the squeeze this workstream fixed. */}
      <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,1fr)_260px]">
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
        </div>

        {/* The tools/palette. In DOM order this sits immediately after the
            canvas, not after the whole studio, because the `@3xl` sidebar is
            the RARE layout: this panel is ~467px at every viewport >= 1024px
            (measured), so the single-column stack is what a desktop actually
            renders. With the palette as the grid's last child it landed ~800px
            below the canvas in that stack — you could see the grid or pick a
            colour, never both, which is a worse studio than the squeezed one
            it replaced. Everything downstream of drawing moves into the
            `@3xl:col-span-2` block below instead, so it stays beneath BOTH
            columns in the sidebar layout rather than being crammed into the
            canvas track while the sidebar sat empty beside it. */}
        <div className="@3xl:sticky @3xl:top-4 @3xl:self-start">
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

        <div className="min-w-0 space-y-5 @3xl:col-span-2">
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
