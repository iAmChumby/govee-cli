"use client";

/**
 * Palette + tool controls — the "what am I painting with, and what tool"
 * strip. Reuses `SwatchRow`/`HexField` from `color-picker.tsx` rather than
 * a third duplicate color control (§5.8). Layout-agnostic: renders as one
 * wrapping row of ≥44px touch targets; `paint-studio-panel.tsx` (the
 * layout owner) decides whether that row sits sticky-bottom on narrow
 * viewports or as a sidebar column on wide ones (§5.7's "bottom sheet on
 * mobile / sidebar on desktop," condensing to the icon-only idiom
 * `top-bar.tsx` already uses for its own mobile nav).
 */

import * as React from "react";
import { PaintBucket, Paintbrush, Pipette, Redo2, Repeat, Trash2, Undo2, Wand2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/icon-button";
import { HexField, SwatchRow } from "../color-picker";
import type { SymmetryAxis } from "./tools/symmetry";
import type { ToolId } from "./use-paint-canvas";

const TOOLS: { id: ToolId; label: string; Icon: typeof Paintbrush }[] = [
  { id: "brush", label: "Brush", Icon: Paintbrush },
  { id: "fill", label: "Fill (tap a cell)", Icon: PaintBucket },
  { id: "gradient", label: "Gradient (tap two points)", Icon: Wand2 },
  { id: "eyedropper", label: "Eyedropper (tap a cell)", Icon: Pipette },
];

const SYMMETRY_OPTIONS: { id: SymmetryAxis; label: string }[] = [
  { id: "none", label: "off" },
  { id: "col", label: "left-right" },
  { id: "row", label: "top-bottom" },
];

export interface PaletteBarProps {
  tool: ToolId;
  onToolChange: (t: ToolId) => void;
  primaryColor: string;
  onPrimaryChange: (hex: string) => void;
  secondaryColor: string;
  onSecondaryChange: (hex: string) => void;
  symmetry: SymmetryAxis;
  onSymmetryChange: (a: SymmetryAxis) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  className?: string;
}

export function PaletteBar({
  tool,
  onToolChange,
  primaryColor,
  onPrimaryChange,
  secondaryColor,
  onSecondaryChange,
  symmetry,
  onSymmetryChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  className,
}: PaletteBarProps) {
  return (
    <div className={cn("space-y-3.5", className)}>
      {/* tools + history */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="Paint tool" className="flex items-center gap-1">
          {TOOLS.map(({ id, label, Icon }) => (
            <IconButton
              key={id}
              label={label}
              tooltip={label}
              aria-pressed={tool === id}
              onClick={() => onToolChange(id)}
              className={cn(tool === id && "border-hairline-strong bg-accent-dim text-hi")}
            >
              <Icon size={15} strokeWidth={1.6} aria-hidden />
            </IconButton>
          ))}
        </div>

        <span aria-hidden className="mx-0.5 h-6 w-px bg-hairline" />

        <IconButton label="Undo" tooltip="Undo (Ctrl/Cmd+Z)" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={15} strokeWidth={1.6} aria-hidden />
        </IconButton>
        <IconButton label="Redo" tooltip="Redo (Ctrl/Cmd+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={15} strokeWidth={1.6} aria-hidden />
        </IconButton>
        <IconButton label="Clear canvas" tooltip="Clear canvas" onClick={onClear}>
          <Trash2 size={15} strokeWidth={1.6} aria-hidden />
        </IconButton>
      </div>

      {/* symmetry */}
      <div className="flex flex-wrap items-center gap-2">
        <Repeat size={13} strokeWidth={1.6} className="text-low" aria-hidden />
        <div role="group" aria-label="Symmetry" className="flex items-center gap-1">
          {SYMMETRY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={symmetry === opt.id}
              onClick={() => onSymmetryChange(opt.id)}
              className={cn(
                "h-7 cursor-pointer rounded-btn border px-2.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors duration-150",
                symmetry === opt.id
                  ? "border-hairline-strong bg-accent-dim text-hi"
                  : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* palette — primary paints; secondary feeds the gradient tool's far end */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-micro text-low">
            primary
          </span>
          <SwatchRow activeHex={primaryColor} onPick={onPrimaryChange} ariaGroupLabel="Primary colors" />
          <HexField onCommit={onPrimaryChange} />
          <span
            aria-hidden
            className="h-7 w-7 shrink-0 rounded-chip border border-hairline-strong"
            style={{ background: primaryColor }}
          />
        </div>
        {tool === "gradient" ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-micro text-low">
              secondary
            </span>
            <SwatchRow
              activeHex={secondaryColor}
              onPick={onSecondaryChange}
              ariaGroupLabel="Secondary colors"
            />
            <HexField onCommit={onSecondaryChange} />
            <span
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-chip border border-hairline-strong"
              style={{ background: secondaryColor }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
