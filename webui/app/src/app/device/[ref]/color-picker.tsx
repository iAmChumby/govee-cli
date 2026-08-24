"use client";

import * as React from "react";

import { cn } from "@/lib/cn";
import { useTrailingCommit } from "./use-trailing-commit";

/* ==================================================================
   Color well controls — curated swatches, a minimal native picker,
   and a validated hex field. All light CONTENT: the palette is the
   only place warm tones are allowed to live (WEBUI_SPEC §5.2).
   ================================================================== */

/** Ten curated paint colors — saturated primaries plus both whites. */
export const SWATCHES: readonly string[] = [
  "#FF4545",
  "#FFA53D",
  "#FFD23D",
  "#46D06A",
  "#3DD6C4",
  "#3D7BFF",
  "#8A5CFF",
  "#FF5CA8",
  "#FFC978",
  "#EAF2FF",
];

export function normalizeHex(raw: string): string | null {
  const v = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : null;
}

interface SwatchRowProps {
  /** currently active hex (uppercase, with #) or null */
  activeHex: string | null;
  onPick: (hex: string) => void;
  ariaGroupLabel?: string;
  className?: string;
}

/** Row of curated swatch buttons; the active color carries an accent ring. */
export function SwatchRow({ activeHex, onPick, ariaGroupLabel = "Curated colors", className }: SwatchRowProps) {
  return (
    <div role="group" aria-label={ariaGroupLabel} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {SWATCHES.map((hex) => {
        const active = activeHex?.toUpperCase() === hex.toUpperCase();
        return (
          <button
            key={hex}
            type="button"
            title={hex}
            aria-label={`Set color ${hex}`}
            aria-pressed={active}
            onClick={() => onPick(hex)}
            className={cn(
              "h-7 w-7 cursor-pointer rounded-chip border border-hairline transition-all duration-150 hover:border-hairline-strong hover:scale-105 active:scale-95",
              active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
            )}
            style={{ background: hex }}
          />
        );
      })}
    </div>
  );
}

interface NativeColorInputProps {
  /** current hex with # — seeds the picker */
  value: string;
  onPick: (hex: string) => void;
  className?: string;
}

/**
 * Minimal native `<input type="color">`: chrome stripped, swatch rounded
 * to the chip radius. Picker changes stream in while the dialog is open,
 * so commits ride the trailing throttle like the dial.
 */
export function NativeColorInput({ value, onPick, className }: NativeColorInputProps) {
  const commit = useTrailingCommit(onPick);
  return (
    <input
      type="color"
      aria-label="Custom color picker"
      value={value}
      onChange={(e) => commit(e.target.value)}
      className={cn(
        "h-7 w-7 cursor-pointer appearance-none rounded-chip border border-hairline bg-transparent p-0 transition-colors duration-150 hover:border-hairline-strong",
        "[&::-webkit-color-swatch-wrapper]:p-0",
        "[&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-none",
        "[&::-moz-color-swatch]:rounded-[5px] [&::-moz-color-swatch]:border-none",
        className,
      )}
    />
  );
}

interface HexFieldProps {
  /** fires with a normalized #RRGGBB on Enter */
  onCommit: (hex: string) => void;
  className?: string;
}

/** Mono hex entry — validates 6 hex digits, submits on Enter only. */
export function HexField({ onCommit, className }: HexFieldProps) {
  const [draft, setDraft] = React.useState("");
  const parsed = draft.trim() ? normalizeHex(draft) : null;
  const invalid = draft.trim() !== "" && parsed === null;

  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed) {
          onCommit(parsed);
          setDraft("");
        }
      }}
    >
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="#HEX"
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        aria-label="Hex color"
        aria-invalid={invalid || undefined}
        className={cn(
          "h-7 w-[86px] rounded-btn border bg-raised px-2 font-mono text-[11px] uppercase tracking-[0.06em] text-hi transition-colors duration-150 placeholder:text-low placeholder:normal-case focus-visible:border-hairline-strong focus-visible:outline-none",
          invalid ? "border-ember" : "border-hairline",
          className,
        )}
      />
    </form>
  );
}
