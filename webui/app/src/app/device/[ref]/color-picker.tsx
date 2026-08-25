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
    // WEBUI_V3_SPEC.md §11.3/T35: ten 28px buttons 6px apart — a hit-area
    // fix here is explicitly the case the spec calls out by name. An
    // `::after` overlay bigger than each 28px box would spill into the
    // 6px gap and beyond, so adjacent swatches would get overlapping hit
    // rectangles and a tap near the seam would land on the neighbour
    // (§11.1's ban, and a worse bug than the one being fixed). Growing
    // the gap alongside the box — `gap-1.5` (6px) to `pointer-coarse:
    // gap-2` (8px) — keeps that from happening once the boxes themselves
    // are real 44px layout boxes rather than an overlay: at 44px real
    // boxes can never overlap regardless of gap, but a wider gap keeps
    // the row from reading as one solid strip on touch.
    <div role="group" aria-label={ariaGroupLabel} className={cn("flex flex-wrap items-center gap-1.5 pointer-coarse:gap-2", className)}>
      {SWATCHES.map((hex) => {
        const active = activeHex?.toUpperCase() === hex.toUpperCase();
        return (
          // The button is the hit target (floored at 44px under
          // `pointer-coarse:`); the swatch's actual color and border live
          // on the inner `span`, fixed at 28px unconditionally, so "the
          // swatch circles must still LOOK the same size" holds even
          // where the button around them has grown.
          <button
            key={hex}
            type="button"
            title={hex}
            aria-label={`Set color ${hex}`}
            aria-pressed={active}
            onClick={() => onPick(hex)}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-chip pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <span
              aria-hidden
              className={cn(
                "block h-7 w-7 rounded-chip border border-hairline transition-all duration-150 hover:border-hairline-strong hover:scale-105 active:scale-95",
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
              style={{ background: hex }}
            />
          </button>
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
    // WEBUI_V3_SPEC.md §11.3/T35: a 28x28 native `<input type="color">`.
    // Unlike `SwatchRow`'s buttons, there is no separate decorative child
    // to grow around here without shrinking it back — a native color
    // input's clickable region is its own rendered box, full stop; a
    // wrapping element with padding around it would *not* extend the
    // input's actual hit area (only clicks on the input's own box open
    // the picker), so the "wrap a smaller visual in a bigger button"
    // pattern this file uses for `SwatchRow` doesn't apply to a real
    // form control. So the input itself is floored at 44px under
    // `pointer-coarse:`, and `::-webkit-color-swatch-wrapper` gets
    // matching padding so the *visible* chip inside stays close to its
    // original 28px — the wrapper is the element Chromium actually
    // paints the color into, sized to the input's content box, so
    // padding on it insets the swatch without touching the input's own
    // (now 44px) box. Firefox has no equivalent wrapper pseudo-element
    // to pad, so `::-moz-color-swatch` is inset with a margin instead —
    // best-effort, not pixel-verified there.
    <input
      type="color"
      aria-label="Custom color picker"
      value={value}
      onChange={(e) => commit(e.target.value)}
      className={cn(
        "h-7 w-7 cursor-pointer appearance-none rounded-chip border border-hairline bg-transparent p-0 transition-colors duration-150 hover:border-hairline-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "[&::-webkit-color-swatch-wrapper]:p-0 pointer-coarse:[&::-webkit-color-swatch-wrapper]:p-2",
        "[&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-none",
        "[&::-moz-color-swatch]:rounded-[5px] [&::-moz-color-swatch]:border-none pointer-coarse:[&::-moz-color-swatch]:m-2",
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
          // WEBUI_V3_SPEC.md §11.3/T35: 86x28 — width already clears
          // 44px, only height is short, and (unlike the swatch controls
          // above) there's no separate "ink" to preserve for a text
          // field — the box itself is the whole control, so it's
          // floored directly rather than wrapped.
          "h-7 w-[86px] rounded-btn border bg-raised px-2 font-mono text-[11px] uppercase tracking-[0.06em] text-hi transition-colors duration-150 placeholder:text-low placeholder:normal-case focus-visible:border-hairline-strong focus-visible:outline-none pointer-coarse:min-h-11",
          invalid ? "border-ember" : "border-hairline",
          className,
        )}
      />
    </form>
  );
}
