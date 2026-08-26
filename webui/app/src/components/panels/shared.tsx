"use client";

/**
 * Shared atoms for the feature panels (phase E).
 *
 * Every panel renders its own <Panel> root via PanelFrame so the control
 * deck stays a dumb tab shell. Visual language is the v2 "optical" bench:
 * flat hairline chrome, micro-label headers, and color only as CONTENT
 * (scene gradients) — never decoration (WEBUI_SPEC §5.2).
 */

import * as React from "react";
import { motion } from "motion/react";

import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fadeUp, staggerParent } from "@/lib/motion";
import { resolveNamedPalette } from "@/lib/motion-engine/classify";
import { INDETERMINATE_PALETTE } from "@/lib/motion-engine/palette";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";

/* ------------------------------------------------------------- gradient */

/**
 * Name → CSS gradient thumb, driven by the SAME curated appearance table and
 * resolver the 3D stage uses (`motion-engine/classify.ts`'s
 * `resolveNamedPalette`, itself backed by `scene-appearance.ts`) — not an
 * independent hash.
 *
 * The bug this replaced: this function used to hash the name with FNV-1a
 * into an HSL pair with zero relation to what `classify.ts`'s OWN, entirely
 * separate, `sum(charCode) % 4` hash chose for the same name. "Aurora"
 * thumbed magenta here while the 3D stage rendered the lava-orange palette —
 * two independent guesses for the same scene that didn't even agree with
 * each other, and neither one was the green/cyan the real lamp shows
 * running Aurora. Routing both through one resolver makes that
 * disagreement structurally impossible, not just coincidentally rare.
 *
 * A name the resolver has no real signal for (`resolveNamedPalette`'s
 * `indeterminate: true`) renders `INDETERMINATE_PALETTE` — the same neutral
 * grey used everywhere else that palette shows up — never a confident-
 * looking hue invented for a name nobody has verified.
 */
export function nameToGradient(name: string): string {
  const { palette, indeterminate } = resolveNamedPalette(name);
  const colors = indeterminate ? INDETERMINATE_PALETTE.colors : palette.colors;
  const stops = colors.length > 1 ? colors : [colors[0], colors[0]];
  return `linear-gradient(135deg, ${stops.join(", ")})`;
}

/* ---------------------------------------------------------- panel frame */

interface PanelFrameProps {
  /** uppercase micro-label rendered as the panel header */
  label: string;
  /** right-aligned meta chips (count, cache state, …) */
  chips?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * The one true panel root: self-owned Panel (p-5) with a header row of
 * label → hairline rule → meta chips. `mt-5` keeps the rhythm with the
 * Light/Segments tabs above.
 */
export function PanelFrame({ label, chips, children, className }: PanelFrameProps) {
  return (
    <Panel className={cn("mt-5 p-5", className)}>
      <header className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-[11px] uppercase leading-none tracking-micro text-mid">
          {label}
        </h3>
        <span aria-hidden className="h-px min-w-8 flex-1 bg-hairline" />
        {chips}
      </header>
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

/* ----------------------------------------------------------- empty state */

interface EmptyStateProps {
  title: string;
  hint?: string;
}

/** Flat dashed well with a quiet title and a mono hint. */
export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="rounded-card border border-dashed border-hairline px-6 py-10 text-center">
      <p className="text-[12px] leading-snug text-mid">{title}</p>
      {hint ? (
        <p className="mx-auto mt-1.5 max-w-[44ch] font-mono text-[10px] leading-relaxed text-low">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ query error */

/** Unwrap query errors the same way the toast path does. */
export function queryErrorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

interface QueryErrorLineProps {
  message: string;
  onRetry?: () => void;
}

/** Inline mono error line with an optional retry affordance. */
export function QueryErrorLine({ message, onRetry }: QueryErrorLineProps) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-ember/30 px-3 py-2.5">
      <p className="min-w-0 font-mono text-[11px] leading-relaxed text-ember">
        {message}
      </p>
      {onRetry ? (
        <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={onRetry}>
          retry
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- lists */

interface StaggerListProps {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}

/** Small-list orchestrator: staggered rise-and-settle on mount. */
export function StaggerList({ children, className, ariaLabel }: StaggerListProps) {
  return (
    <motion.ul
      variants={staggerParent}
      initial="hidden"
      animate="show"
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </motion.ul>
  );
}

interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
}

export function StaggerItem({ children, className }: StaggerItemProps) {
  return (
    <motion.li variants={fadeUp} className={className}>
      {children}
    </motion.li>
  );
}

/* ------------------------------------------------------------- skeletons */

/** Scenes grid card placeholder — thumb square + two text lines. */
export function ThumbCardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-card border border-hairline bg-raised p-2.5">
      <Skeleton className="h-10 w-10 shrink-0 rounded-chip" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-2.5 w-3/4" />
        <Skeleton className="h-2 w-12" />
      </div>
    </div>
  );
}

/** List-row placeholder matching the diy/snapshot/toggle/effect rows. */
export function RowSkeleton({ edge = false }: { edge?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-hairline px-3 py-2.5">
      {edge ? <Skeleton className="h-8 w-[3px] shrink-0 rounded-full" /> : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-2.5 w-1/3" />
        <Skeleton className="h-2 w-1/4" />
      </div>
      <Skeleton className="h-7 w-14 shrink-0 rounded-btn" />
    </div>
  );
}

/** Mode-chip row placeholder for the music panel. */
export function ChipRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-8 w-20 rounded-chip" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- swatches */

// Curated paint palette — mirrors color-picker.SWATCHES (kept local so the
// panels layer stays decoupled from the device-route folder).
const PAINT_SWATCHES: readonly string[] = [
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

interface MiniSwatchesProps {
  activeHex: string | null;
  onPick: (hex: string) => void;
  ariaGroupLabel?: string;
  className?: string;
}

/** Compact swatch row for fixed-color picks; active swatch wears the accent ring. */
export function MiniSwatches({
  activeHex,
  onPick,
  ariaGroupLabel = "Fixed colors",
  className,
}: MiniSwatchesProps) {
  return (
    <div
      role="group"
      aria-label={ariaGroupLabel}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {PAINT_SWATCHES.map((hex) => {
        const active = activeHex?.toUpperCase() === hex.toUpperCase();
        return (
          <button
            key={hex}
            type="button"
            title={hex}
            aria-label={`Use color ${hex}`}
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

/* ------------------------------------------------------------ meta chips */

interface CountChipProps {
  count: number;
  singular: string;
  plural?: string;
  className?: string;
}

/** Mono count chip: "69 scenes" / "1 scene". */
export function CountChip({ count, singular, plural, className }: CountChipProps) {
  return (
    <Chip className={className}>
      {count} {count === 1 ? singular : plural ?? `${singular}s`}
    </Chip>
  );
}
