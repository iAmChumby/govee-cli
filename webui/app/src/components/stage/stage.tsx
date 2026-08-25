"use client";

import * as React from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import type { DeviceState, DeviceSummary } from "@/lib/api";
import { useDeleteActiveMode } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import {
  clamp,
  emissionHsl,
  hslCss,
  hslaCss,
  kelvinToRgb,
  rgbToHsl,
  withLightness,
  WARM_HSL,
  type Hsl,
} from "./color";
import { MotionCanvas } from "@/lib/motion-engine/MotionCanvas";
import { classifyActiveMode } from "@/lib/motion-engine/classify";
import { buildGeometry } from "@/lib/motion-engine/geometry";
import { UnknownModeChooser } from "./mode-picker";
import type {
  ActiveMode as MotionActiveMode,
  ActiveModeKind as MotionActiveModeKind,
  MotionSpec,
} from "@/lib/motion-engine/types";

/* ==================================================================
   DeviceStage — the optical bench centerpiece (WEBUI_SPEC §5.4).

   Per-model faithful rendering driven entirely by live state:

     H6056  two vertical light bars — continuous glowing diffuser
             tubes on machined bases (zones 0-2 left, 3-5 right as
             invisible paint bands over each tube)
     H6022  table lamp — a fabric shade hiding a 132-led matrix:
             12 columns wrapped around the drum × 11 rows. The
             lattice shows through as the led grid. Cloud v2 only
             exposes 15 coarse segments over it, so paint mode
             addresses a linear 0-14 rail — never matrix cells
     H6008  single orb bulb with layered halo and socket collar
     other  generic orb

   Life:
   - filament warm-up — powering on ignites a warm-white layer that
     settles into the set color over ~1.2s (spring-driven warmth)
   - emission tracks brightness: glow opacity AND surface lightness
     both scale, so 20% reads dim, not just less blurry
   - idle breath oscillates the halo ±4% unless reduced motion
   - nothing snaps: every visible change rides a spring or a CSS
     color transition

   Paint mode: pass `interactive` to make zones toggleable buttons.
   Selection is controlled (`selected` + `onSelectionChange`) or, when
   the parent doesn't own it, internal — in which case a floating apply
   affordance appears and fires `onPaintSegments(indices)`.

   variant="mini" renders the same instruments compactly for console
   plates — same physics, pocket size.
   ================================================================== */

export interface DeviceStageProps {
  state: DeviceState | DeviceSummary;
  /** zones become toggleable paint-target buttons */
  interactive?: boolean;
  /** controlled selection; omit to let the stage own it */
  selected?: number[];
  onSelectionChange?: (indices: number[]) => void;
  /**
   * Fired by the stage's floating apply affordance (uncontrolled mode)
   * with the selected segment indices. Controlled consumers ignore this
   * and apply from their own UI instead.
   */
  onPaintSegments?: (segments: number[], hex?: string, brightness?: number) => void;
  /** full = device console centerpiece; mini = console plate preview */
  variant?: "full" | "mini";
  /**
   * Real per-cell paint data for the H6022's `MatrixLattice` (row-major,
   * length `matrix_rows * matrix_cols`) — WEBUI_V3_SPEC.md §5's paint
   * studio is the intended future producer. Omit (or pass `null`) to keep
   * the lattice's existing decorative hairline-only rendering; this task
   * only makes `MatrixLattice` *capable* of taking real data, it does not
   * wire a producer.
   */
  matrixCells?: readonly string[] | null;
  className?: string;
}

/** Physical truth per model — what the hardware actually shows. */
function zoneCountFor(state: DeviceState | DeviceSummary): number | null {
  if (state.model === "H6056") return 6;
  if (state.model === "H6022") {
    const caps = "capabilities" in state ? state.capabilities : undefined;
    return caps?.segment_count_cloud ?? 15;
  }
  return null; // orb models (H6008) and unknowns
}

function hasSocket(model: string | null): boolean {
  return model === "H6008";
}

/** Brightness as a 0..1 emission factor with a visible floor. */
function brightnessGlow(brightness: number | null): number {
  return 0.25 + 0.75 * (clamp(brightness ?? 50, 1, 100) / 100);
}

/** Neutral, near-desaturated chassis tone used for Halo/EmissionLayers/core
 *  whenever the §4.3 motion texture layer is mounted. Without this, the
 *  instrument's own glow keeps rendering `activeHsl` — a guess sourced from
 *  possibly-stale `color`/`color_temp_k` — underneath the texture layer,
 *  which is exactly the dishonest "confident guess" §4.3 exists to remove.
 *  The chassis still breathes with `glow`/`warm` (power/brightness are real
 *  reads); only the *hue* claim is dropped in favor of the classified
 *  `MotionSpec` drawn on top. */
const NEUTRAL_CHASSIS_HSL: Hsl = [0, 0, 22];

/** The single color the whole instrument is emitting right now — the
 *  `basic`/`off`/`unknown`/no-active fallback. Used verbatim for those
 *  cases (zero regression, WEBUI_V3_SPEC.md §4.3's hard requirement); for
 *  every other `active.mode` the texture layer below takes over instead of
 *  guessing a static color from possibly-stale `color`/`color_temp_k`. */
function useActiveHsl(state: DeviceState | DeviceSummary): Hsl {
  return React.useMemo<Hsl>(() => {
    if (state.color) return rgbToHsl(state.color.rgb);
    if (state.color_temp_k !== null && state.color_temp_k !== undefined) {
      return rgbToHsl(kelvinToRgb(state.color_temp_k));
    }
    return WARM_HSL;
  }, [state.color, state.color_temp_k]);
}

/* --------------------------------------------------------- active mode texture
   WEBUI_V3_SPEC.md §4.3 — the direct fix for "the GUI doesn't match what I
   see": once the ledger (§3) knows a device is running a scene/DIY/music
   mode/segment paint/effect (not just a plain color the cloud can verify),
   rendering a guessed flat HSL is dishonest — the cloud always reads back
   empty for those instances, so a solid-color render would silently claim
   certainty that doesn't exist. `off`/`basic`/`unknown` (and a defensively
   handled missing `active` field) are the one path required to render
   byte-for-byte identical to pre-T12 stage.tsx — `unknown` is included
   deliberately: it means "no record at all," and motion there would
   fabricate the exact kind of claim this ledger exists to avoid. */

interface MotionModeMeta {
  /** motion-engine's own classification input (types.ts `ActiveModeKind`) */
  kind: MotionActiveModeKind;
  /** human phrase for the caption, e.g. "sleep — DIY scene" */
  label: string;
}

/** Maps the ledger's `active.mode` (api.ts) to the motion engine's own
 *  classification kind (motion-engine/types.ts) per §4.4's mapping
 *  comment. Returns `null` for `off`/`basic`/`unknown` (and anything else
 *  unrecognized) — the signal to keep rendering the existing solid path. */
function motionModeMetaFor(mode: DeviceState["active"]["mode"] | undefined): MotionModeMeta | null {
  switch (mode) {
    case "scene":
      return { kind: "firmware_scene", label: "scene" };
    case "diy":
      return { kind: "diy_scene", label: "DIY scene" };
    case "music":
      return { kind: "music_mode", label: "music mode" };
    case "snapshot":
      return { kind: "solid", label: "snapshot" };
    case "segments":
      return { kind: "segment_paint", label: "segments" };
    case "effect":
      return { kind: "effect", label: "effect" };
    default:
      return null; // off | basic | unknown | undefined
  }
}

/** api.ts's `ActiveModeSource` ("cli"|"webui"|"schedule"|"group"|null) onto
 *  motion-engine's own `ActiveMode.source` ("ui"|"schedule"|"cli"|"group"|
 *  "unknown") — the two were named independently, this is the one place
 *  they need reconciling. */
function motionSourceFor(source: DeviceState["active"]["source"]): MotionActiveMode["source"] {
  if (source === "webui") return "ui";
  return source ?? "unknown";
}

/** Builds the motion engine's own `ActiveMode` input from the ledger's
 *  merged `active` field plus the live-read color/temp as the fallback
 *  palette source for kinds (`solid`, and — via `classifySegmentPaint` —
 *  `segment_paint`) that render off a single color rather than a name. */
function buildMotionActiveMode(
  state: DeviceState | DeviceSummary,
  active: DeviceState["active"],
  kind: MotionActiveModeKind,
): MotionActiveMode {
  return {
    kind,
    name: active.label ?? undefined,
    color: state.color ? { r: state.color.rgb[0], g: state.color.rgb[1], b: state.color.rgb[2] } : null,
    colorTempK: state.color_temp_k ?? null,
    confidence: active.confidence,
    ageSeconds: active.age_seconds,
    source: motionSourceFor(active.source),
  };
}

/** "3h ago" / "45s ago" — coarse, matches the caption's own low-precision
 *  register (this is a "how stale is this claim" cue, not a stopwatch). */
function formatAgeShort(seconds: number | null): string | null {
  if (seconds === null) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** e.g. `"sleep — DIY scene, assumed, 3h ago"` — the exact form
 *  §4.3 specifies. Confidence is always spelled out verbatim (never
 *  softened, never omitted) so "assumed"/"external"/"unknown" can never
 *  be mistaken for "confirmed" at a glance. */
function activeModeCaption(active: DeviceState["active"], kindLabel: string): string {
  const head = active.label ? `${active.label} — ${kindLabel}` : kindLabel;
  const age = formatAgeShort(active.age_seconds);
  return [head, active.confidence, age].filter((part): part is string => Boolean(part)).join(", ");
}

/**
 * The "that is not what I see" reset (§3.6/§4.3): clears the ledger entry
 * for this device via `DELETE /devices/{ref}/active-mode` (T10's
 * `useDeleteActiveMode`), which drops `active.mode` back to `unknown` on
 * the next read — the honest "we don't know anymore" state, not a guess at
 * what's actually running.
 */
function ActiveModeReset({ deviceRef }: { deviceRef: string }) {
  const deleteActiveMode = useDeleteActiveMode();
  const [busy, setBusy] = React.useState(false);

  const handleReset = React.useCallback(() => {
    setBusy(true);
    void deleteActiveMode(deviceRef).finally(() => setBusy(false));
  }, [deleteActiveMode, deviceRef]);

  return (
    <button
      type="button"
      aria-label="Not what I see — reset active mode"
      title="Not what I see — reset"
      onClick={handleReset}
      disabled={busy}
      className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-low outline-none transition-colors duration-150 hover:text-hi active:scale-95 disabled:opacity-40"
    >
      <RotateCcw aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}

/** Spring-driven 0..1 emission for the whole instrument. */
function useGlow(power: boolean, brightness: number | null): MotionValue<number> {
  const glow = useSpring(0, springStandard);
  const target = power ? brightnessGlow(brightness) : 0;

  React.useEffect(() => {
    void animate(glow, target, springStandard);
  }, [glow, target]);

  return glow;
}

/**
 * Filament warm-up: 1 = fully warm-white, 0 = settled on the set color.
 * Powering on snaps the filament to warm and lets it settle slowly; power
 * off just lets it die. Mounting with power already on replays the ignite —
 * the app visibly "comes alive" on load.
 */
function useWarmth(power: boolean): MotionValue<number> {
  const warmth = useSpring(0, { stiffness: 46, damping: 18 });
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (reduced || !power) {
      warmth.set(0);
      return;
    }
    warmth.set(1);
    void animate(warmth, 0, { stiffness: 46, damping: 18, type: "spring" });
  }, [power, reduced, warmth]);

  return warmth;
}

/** Halo light color — lifted so even deep reported colors still read as light. */
function glowHsl(hsl: Hsl): Hsl {
  return [hsl[0], hsl[1], Math.max(hsl[2], 58)];
}

/* ------------------------------------------------------------------ atoms */

/**
 * Idle breath: ±4% opacity oscillation over ~6.5s. Renders children
 * untouched when the user prefers reduced motion.
 */
function Breath({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      animate={{ opacity: [1, 0.96, 1] }}
      transition={{ duration: 6.5, repeat: Infinity, ease: "easeInOut" }}
    >
      {children}
    </motion.div>
  );
}

interface HaloProps {
  glow: MotionValue<number>;
  /** peak alpha of this layer at full glow */
  strength: number;
  background: string;
  className?: string;
}

/**
 * One blurred radial-gradient light layer. The outer span carries static
 * positioning (including any Tailwind translates); the inner layer is the
 * only thing motion touches, so spring transforms never fight layout
 * utilities. Opacity rides the registered --glow-alpha property (so it
 * interpolates continuously even across theme/DOM churn); scale breathes
 * open with intensity.
 */
function Halo({ glow, strength, background, className }: HaloProps) {
  const alpha = useTransform(glow, (g) => g * strength);
  const scale = useTransform(glow, [0, 1], [0.82, 1.1]);
  return (
    <span aria-hidden className={cn("pointer-events-none absolute block", className)}>
      <motion.span
        className="absolute inset-0 block will-change-transform"
        style={
          {
            "--glow-alpha": alpha,
            opacity: "var(--glow-alpha)",
            scale,
            background,
          } as unknown as React.CSSProperties
        }
      />
    </span>
  );
}

interface Emission {
  /** 0..1 overall emission (power × brightness spring) */
  glow: MotionValue<number>;
  /** warm-white fraction during filament warm-up (pre-multiplied by glow) */
  warm: MotionValue<number>;
  /** brightness-scaled emitting color, css */
  lit: string;
  /** halo color (lightness-lifted) as HSL for alpha variants */
  haloHsl: Hsl;
  /** bright core color, css */
  core: string;
}

const WARM_CSS = hslCss(WARM_HSL);

/**
 * Static cylindrical form shading — laid over any solid emission color to
 * turn a flat fill into a tube/lens. Pure black/white alphas so the color
 * beneath stays free to CSS-transition when the device changes color.
 */
const CYLINDER_SHADING =
  "linear-gradient(90deg, rgb(0 0 0 / 0.52), rgb(0 0 0 / 0.12) 22%, rgb(255 255 255 / 0.22) 46%, rgb(255 255 255 / 0.05) 58%, rgb(0 0 0 / 0.16) 78%, rgb(0 0 0 / 0.55))";

/**
 * The pair of layers every emitting surface is built from: a warm filament
 * layer that dies away as the set color settles in, over the lit color layer.
 * Both fade with the glow spring; the lit layer CSS-transitions its color so
 * device color changes glide.
 */
function EmissionLayers({ e, radius = "rounded-[inherit]" }: { e: Emission; radius?: string }) {
  return (
    <>
      <motion.span
        aria-hidden
        className={cn("absolute inset-0", radius)}
        style={{ opacity: e.warm, backgroundColor: WARM_CSS }}
      />
      <motion.span
        aria-hidden
        className={cn(
          "absolute inset-0 transition-[background-color] duration-[240ms] [transition-timing-function:var(--ease-out-soft)]",
          radius,
        )}
        style={{ opacity: e.glow, backgroundColor: e.lit }}
      />
    </>
  );
}

interface ZoneBandProps {
  index: number;
  interactive: boolean;
  selected: boolean;
  onToggle?: (index: number) => void;
  className?: string;
}

/**
 * An invisible paint-target band laid over a continuous emitting surface.
 * The surface stays untouched — selection shows as an inset accent ring,
 * hover as a faint hairline — so the instrument never decomposes into boxes.
 */
function ZoneBand({ index, interactive, selected, onToggle, className }: ZoneBandProps) {
  if (!interactive) return null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Segment ${index}`}
      onClick={() => onToggle?.(index)}
      className={cn(
        "group relative min-h-0 cursor-pointer outline-none",
        "after:absolute after:inset-[3px] after:rounded-[inherit] after:border after:border-transparent",
        "after:transition-colors after:duration-150 hover:after:border-hairline-strong",
        className,
      )}
    >
      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: selected ? 1 : 0 }}
        transition={springStandard}
        className="absolute inset-[3px] rounded-[inherit] border-2 border-accent"
      />
    </button>
  );
}

/* ------------------------------------------------------------- H6056 bars */

interface InstrumentProps {
  e: Emission;
  interactive: boolean;
  isSelected: (index: number) => boolean;
  onToggle: (index: number) => void;
  mini: boolean;
}

function LightBar({
  zones,
  e,
  interactive,
  isSelected,
  onToggle,
  mini,
}: InstrumentProps & { zones: [number, number, number] }) {
  const coreOpacity = useCoreOpacity(e.glow);
  return (
    <div className="relative flex flex-col items-center">
      {/* halo behind the tube — color + warm filament pass */}
      <Halo
        glow={e.glow}
        strength={mini ? 0.5 : 0.6}
        background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.6)}, transparent 72%)`}
        className={mini ? "-inset-x-6 -top-8 bottom-2" : "-inset-x-14 -top-24 bottom-6"}
      />
      <Halo
        glow={e.warm}
        strength={mini ? 0.4 : 0.5}
        background={`radial-gradient(closest-side, ${hslaCss(WARM_HSL, 0.55)}, transparent 72%)`}
        className={mini ? "-inset-x-6 -top-8 bottom-2" : "-inset-x-14 -top-24 bottom-6"}
      />

      {/* glass tube: one continuous diffuser, zones as invisible bands */}
      <div
        className={cn(
          "relative flex flex-col-reverse overflow-hidden rounded-full border border-hairline-strong bg-bg",
          mini ? "h-[92px] w-[13px] p-[2px]" : "h-[204px] w-[26px] p-[3px]",
        )}
      >
        {/* off glass */}
        <span aria-hidden className="absolute inset-0 rounded-full bg-accent-dim" />
        <EmissionLayers e={e} radius="rounded-full" />
        {/* hot core line */}
        <motion.span
          aria-hidden
          className={cn(
            "absolute inset-y-[7%] left-1/2 -translate-x-1/2 rounded-full",
            mini ? "w-[2px]" : "w-[3px]",
          )}
          style={{
            opacity: coreOpacity,
            backgroundColor: e.core,
            filter: "blur(1.5px)",
          }}
        />
        {/* cylindrical form */}
        <span aria-hidden className="absolute inset-0 rounded-full" style={{ background: CYLINDER_SHADING }} />
        {/* paint bands */}
        {zones.map((i) => (
          <ZoneBand
            key={i}
            index={i}
            interactive={interactive}
            selected={isSelected(i)}
            onToggle={onToggle}
            className="flex-1 rounded-full"
          />
        ))}
      </div>

      {/* machined base */}
      <div
        className={cn(
          "mt-[6px] flex items-start justify-center rounded-btn border border-hairline-strong bg-panel",
          mini ? "h-[7px] w-[34px]" : "h-[13px] w-[58px]",
        )}
      >
        <span
          aria-hidden
          className={cn("rounded-full", mini ? "mt-[2px] h-px w-[70%]" : "mt-[3px] h-px w-[70%]")}
          style={{ backgroundColor: "var(--hairline-strong)" }}
        />
      </div>
    </div>
  );
}

/** Core line burns brighter than the body: opacity eased toward 1. */
function useCoreOpacity(glow: MotionValue<number>): MotionValue<number> {
  return useTransform(glow, (g) => Math.min(1, g * 1.35));
}

function BarsStage(props: InstrumentProps) {
  const { e, mini } = props;
  return (
    <div
      className={cn(
        "relative flex h-full items-end justify-center",
        mini ? "gap-9 pb-5" : "gap-16 pb-16",
      )}
    >
      {/* floor reflection between the bases */}
      <Halo
        glow={e.glow}
        strength={0.26}
        background={`linear-gradient(to bottom, ${hslaCss(e.haloHsl, 0.35)}, transparent 85%)`}
        className={
          mini
            ? "bottom-1 left-1/2 h-4 w-[150px] -translate-x-1/2 blur-md"
            : "bottom-3 left-1/2 h-9 w-[300px] -translate-x-1/2 blur-md"
        }
      />
      {/* ambient wash above the pair */}
      <Breath>
        <Halo
          glow={e.glow}
          strength={mini ? 0.18 : 0.22}
          background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.4)}, transparent 70%)`}
          className={
            mini
              ? "left-1/2 top-1 h-20 w-[220px] -translate-x-1/2 blur-xl"
              : "left-1/2 top-2 h-40 w-[420px] -translate-x-1/2 blur-3xl"
          }
        />
      </Breath>

      <LightBar {...props} zones={[0, 1, 2]} />
      <LightBar {...props} zones={[3, 4, 5]} />
    </div>
  );
}

/* ------------------------------------------------------------- H6022 lamp */

/* ----------------------------------------------------------- H6022 matrix */

/**
 * Hardware truth: the H6022's shade hides a 132-led matrix — 12 columns
 * wrapped around the drum × 11 rows tall (index = row*12 + col, col 0
 * touching col 11). Cloud v2 exposes only 15 coarse segments over it —
 * an API template the firmware interpolates onto the matrix, physical
 * mapping unverified — so paint mode addresses the linear 0-14 rail,
 * never individual cells.
 */
const MATRIX_COLS = 12;
const MATRIX_ROWS = 11;

/**
 * The led grid showing through the fabric. One SVG of hairlines: column
 * lines sit on a cosine projection so edge columns compress like a wrapped
 * cylinder, row lines are even (horizontal rings). Opacity rides the glow —
 * the lattice is barely there when off.
 *
 * Promoted (WEBUI_V3_SPEC.md §2/§5.5) to *optionally* accept real per-cell
 * paint data via `cells` — row-major, length `MATRIX_ROWS * MATRIX_COLS`,
 * matching the same `index = row*12 + col` convention CLAUDE.md documents
 * for the real hardware. When `cells` is omitted (or the wrong length),
 * the component renders exactly its pre-existing decorative hairline-only
 * form — this task only makes it *capable* of real data; the paint studio
 * (§5) is the intended future producer and does not consume this yet.
 */
function MatrixLattice({
  glow,
  mini,
  cells,
}: {
  glow: MotionValue<number>;
  mini: boolean;
  /** real row-major per-cell CSS colors, or omit for decorative-only */
  cells?: readonly string[] | null;
}) {
  const opacity = useTransform(glow, (g) => (mini ? 0.05 : 0.07) + 0.16 * g);
  const cellOpacity = useTransform(glow, (g) => 0.35 + 0.55 * g);
  const colXs = React.useMemo(
    () =>
      Array.from(
        { length: MATRIX_COLS - 1 },
        (_, i) => 50 - 50 * Math.cos((Math.PI * (i + 1)) / MATRIX_COLS),
      ),
    [],
  );
  const rowYs = React.useMemo(
    () => Array.from({ length: MATRIX_ROWS - 1 }, (_, i) => ((i + 1) / MATRIX_ROWS) * 100),
    [],
  );
  const colBounds = React.useMemo(() => [0, ...colXs, 100], [colXs]);
  const rowBounds = React.useMemo(() => [0, ...rowYs, 100], [rowYs]);
  const hasCells = cells != null && cells.length === MATRIX_ROWS * MATRIX_COLS;

  return (
    <motion.svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {hasCells ? (
        <motion.g style={{ opacity: cellOpacity }}>
          {Array.from({ length: MATRIX_ROWS }, (_, row) =>
            Array.from({ length: MATRIX_COLS }, (_, col) => {
              const index = row * MATRIX_COLS + col;
              const x = colBounds[col]!;
              const y = rowBounds[row]!;
              return (
                <rect
                  key={`cell-${index}`}
                  x={x}
                  y={y}
                  width={colBounds[col + 1]! - x}
                  height={rowBounds[row + 1]! - y}
                  fill={cells![index]}
                />
              );
            }),
          )}
        </motion.g>
      ) : null}
      <motion.g style={{ opacity }}>
        {colXs.map((x) => (
          <line
            key={`col-${x}`}
            x1={x}
            y1={0}
            x2={x}
            y2={100}
            stroke="rgb(0 0 0 / 0.55)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {rowYs.map((y) => (
          <line
            key={`row-${y}`}
            x1={0}
            y1={y}
            x2={100}
            y2={y}
            stroke="rgb(0 0 0 / 0.55)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </motion.g>
    </motion.svg>
  );
}

/**
 * The cloud's linear segment address space (0-14) as an interactive rail.
 * This is what the API accepts — the firmware interpolates these onto the
 * matrix, so the rail deliberately sits beside the lamp, not on it.
 */
function SegmentRail({
  count,
  isSelected,
  onToggle,
}: {
  count: number;
  isSelected: (index: number) => boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex items-end gap-[3px]">
        {Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={isSelected(i)}
            aria-label={`Segment ${i}`}
            onClick={() => onToggle(i)}
            className="relative h-[22px] w-[15px] cursor-pointer rounded-[4px] border border-hairline bg-white/[0.03] outline-none transition-colors duration-150 hover:border-hairline-strong hover:bg-white/[0.06]"
          >
            <motion.span
              aria-hidden
              initial={false}
              animate={{ opacity: isSelected(i) ? 1 : 0, scale: isSelected(i) ? 1 : 0.6 }}
              transition={springStandard}
              className="absolute inset-[2px] rounded-[3px] bg-accent"
            />
          </button>
        ))}
      </div>
      <span className="font-mono text-[9px] leading-none tracking-micro text-low">
        cloud segments 0–{count - 1} · firmware-interpolated
      </span>
    </div>
  );
}

function MatrixLampStage({
  e,
  segmentCount,
  interactive,
  isSelected,
  onToggle,
  mini,
  matrixCells,
}: InstrumentProps & { segmentCount: number; matrixCells?: readonly string[] | null }) {
  const coreOpacity = useCoreOpacity(e.glow);
  const rail = interactive && !mini;

  return (
    <div
      className={cn(
        "relative flex h-full flex-col items-center justify-end",
        mini ? "pb-4" : rail ? "pb-5" : "pb-14",
      )}
    >
      <Breath>
        {/* dome glow escaping the top of the shade */}
        <Halo
          glow={e.glow}
          strength={mini ? 0.45 : 0.6}
          background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.55)}, transparent 70%)`}
          className={
            mini
              ? "left-1/2 top-0 h-20 w-[160px] -translate-x-1/2 blur-xl"
              : "left-1/2 top-4 h-44 w-[340px] -translate-x-1/2 blur-2xl"
          }
        />
        {/* side spill down the shade flanks */}
        <Halo
          glow={e.glow}
          strength={mini ? 0.28 : 0.35}
          background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.4)}, transparent 72%)`}
          className={
            mini
              ? "bottom-6 left-1/2 h-24 w-[130px] -translate-x-1/2 blur-lg"
              : "bottom-16 left-1/2 h-[280px] w-[260px] -translate-x-1/2 blur-2xl"
          }
        />
      </Breath>

      {/* shade: a fabric cylinder glowing from within */}
      <div
        className={cn(
          "relative overflow-hidden border border-hairline-strong bg-bg",
          mini
            ? "h-[104px] w-[58px] rounded-t-[29px] rounded-b-[8px]"
            : "h-[238px] w-[112px] rounded-t-[56px] rounded-b-[14px]",
          mini ? "p-[3px]" : "p-[6px]",
        )}
      >
        {/* off fabric */}
        <span aria-hidden className="absolute inset-0 bg-accent-dim" />
        <EmissionLayers e={e} />

        {/* inner core — the bulb inside the shade */}
        <motion.span
          aria-hidden
          className={cn(
            "absolute rounded-full",
            mini ? "inset-x-[22%] inset-y-[10%]" : "inset-x-[20%] inset-y-[8%]",
          )}
          style={{
            opacity: coreOpacity,
            background: `radial-gradient(ellipse at 50% 42%, ${e.core}, transparent 72%)`,
            filter: mini ? "blur(6px)" : "blur(14px)",
          }}
        />

        {/* cylindrical form */}
        <span
          aria-hidden
          className="absolute inset-0"
          style={{ background: CYLINDER_SHADING }}
        />
        {/* fabric weave */}
        <span
          aria-hidden
          className={cn("absolute inset-0", mini ? "opacity-[0.04]" : "opacity-[0.05]")}
          style={{
            background: `repeating-linear-gradient(90deg, rgb(255 255 255 / 0.6) 0 1px, transparent 1px ${mini ? 2 : 3}px)`,
          }}
        />
        {/* dome inner shadow */}
        <span
          aria-hidden
          className="absolute inset-x-0 top-0"
          style={{
            height: mini ? 14 : 40,
            borderRadius: mini ? 29 : 56,
            background: "linear-gradient(to bottom, rgb(0 0 0 / 0.32), transparent)",
          }}
        />

        {/* the led matrix showing through the weave */}
        <MatrixLattice glow={e.glow} mini={mini} cells={matrixCells} />
      </div>

      {/* base foot */}
      <div
        className={cn(
          "-mt-px rounded-b-btn border border-hairline-strong bg-panel",
          mini ? "h-[6px] w-[76px]" : "h-[12px] w-[152px]",
        )}
      />

      {/* cloud segment rail — the only addressable surface over cloud v2 */}
      {rail ? (
        <div className="mt-3">
          <SegmentRail count={segmentCount} isSelected={isSelected} onToggle={onToggle} />
        </div>
      ) : null}

      {/* floor pool of light */}
      <Halo
        glow={e.glow}
        strength={mini ? 0.2 : 0.25}
        background={`linear-gradient(to bottom, ${hslaCss(e.haloHsl, 0.32)}, transparent 85%)`}
        className={
          mini
            ? "bottom-1 left-1/2 h-4 w-[120px] -translate-x-1/2 blur-md"
            : "bottom-3 left-1/2 h-8 w-[220px] -translate-x-1/2 blur-md"
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------- orbs */

function OrbStage({ e, socket, mini }: { e: Emission; socket: boolean; mini: boolean }) {
  const orb = mini ? 46 : 108;

  return (
    <div className="relative flex h-full flex-col items-center justify-center">
      <Breath>
        {/* outer halo */}
        <Halo
          glow={e.glow}
          strength={mini ? 0.32 : 0.4}
          background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.45)}, transparent 70%)`}
          className={
            mini
              ? "left-1/2 top-1/2 h-[120px] w-[120px] -translate-x-1/2 -translate-y-1/2 blur-xl"
              : "left-1/2 top-1/2 h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 blur-3xl"
          }
        />
        {/* mid halo */}
        <Halo
          glow={e.glow}
          strength={mini ? 0.5 : 0.65}
          background={`radial-gradient(closest-side, ${hslaCss(e.haloHsl, 0.6)}, transparent 72%)`}
          className={
            mini
              ? "left-1/2 top-1/2 h-[76px] w-[76px] -translate-x-1/2 -translate-y-1/2 blur-lg"
              : "left-1/2 top-1/2 h-[190px] w-[190px] -translate-x-1/2 -translate-y-1/2 blur-xl"
          }
        />
        {/* warm filament halo */}
        <Halo
          glow={e.warm}
          strength={mini ? 0.4 : 0.55}
          background={`radial-gradient(closest-side, ${hslaCss(WARM_HSL, 0.55)}, transparent 72%)`}
          className={
            mini
              ? "left-1/2 top-1/2 h-[76px] w-[76px] -translate-x-1/2 -translate-y-1/2 blur-lg"
              : "left-1/2 top-1/2 h-[190px] w-[190px] -translate-x-1/2 -translate-y-1/2 blur-xl"
          }
        />
      </Breath>

      <div className="relative flex flex-col items-center">
        {/* orb: permanent glass well + lit sphere fading in on the glow spring */}
        <div
          className="relative rounded-full border border-hairline bg-accent-dim"
          style={{ height: orb, width: orb }}
        >
          <EmissionLayers e={e} radius="rounded-full" />
          {/* glass form: specular highlight + limb darkening (static) */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-full border border-hairline-strong"
            style={{
              background:
                "radial-gradient(circle at 35% 28%, rgb(255 255 255 / 0.5), transparent 40%), radial-gradient(circle at 50% 55%, transparent 52%, rgb(0 0 0 / 0.38) 100%)",
            }}
          />
        </div>
        {socket ? (
          <>
            <div
              className={cn(
                "-mt-1 rounded-b-chip border border-hairline-strong bg-panel",
                mini ? "h-[5px] w-[16px]" : "h-[11px] w-[34px]",
              )}
            />
            <div
              className={cn(
                "rounded-b-btn border-x border-b border-hairline-strong bg-panel",
                mini ? "h-[3px] w-[26px]" : "h-[6px] w-[54px]",
              )}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ composition */

export function DeviceStage({
  state,
  interactive = false,
  selected,
  onSelectionChange,
  onPaintSegments,
  variant = "full",
  matrixCells,
  className,
}: DeviceStageProps) {
  const isControlled = selected !== undefined;
  const [internalSel, setInternalSel] = React.useState<number[]>([]);
  const sel = selected ?? internalSel;
  const mini = variant === "mini";

  const activeHsl = useActiveHsl(state);
  const glow = useGlow(state.power === true, state.brightness);
  const warmth = useWarmth(state.power === true);
  const warm = useTransform([glow, warmth], ([g, w]: number[]) => g * w);

  // §4.3: check active.mode FIRST, before building the instrument's own
  // emission colors — a non-basic/non-off/non-unknown mode must not let
  // `activeHsl` (a guess from possibly-stale `color`/`color_temp_k`) drive
  // Halo/EmissionLayers/core. `active` is typed as required on both
  // DeviceState/DeviceSummary, but read through a local `| undefined`
  // binding anyway (no cast) so a defensively-missing field at runtime
  // falls through to `motionMeta === null` — the same "keep today's
  // rendering" path as basic/off/unknown, per the regression guard.
  const active: DeviceState["active"] | undefined = state.active;
  const motionMeta = motionModeMetaFor(active?.mode);
  const hasMotionTexture = motionMeta !== null;
  const chassisHsl = hasMotionTexture ? NEUTRAL_CHASSIS_HSL : activeHsl;

  const factor = brightnessGlow(state.brightness);
  const e: Emission = React.useMemo(
    () => ({
      glow,
      warm,
      lit: hslCss(emissionHsl(chassisHsl, factor)),
      haloHsl: glowHsl(chassisHsl),
      core: hslCss(withLightness(chassisHsl, Math.min(chassisHsl[2] + 30, 96))),
    }),
    [glow, warm, chassisHsl, factor],
  );

  const zones = zoneCountFor(state);
  const name = state.name ?? state.ref;

  const isSelected = React.useCallback((i: number) => sel.includes(i), [sel]);

  const toggle = React.useCallback(
    (i: number) => {
      if (!interactive) return;
      const next = sel.includes(i)
        ? sel.filter((x) => x !== i)
        : [...sel, i].sort((a, b) => a - b);
      if (!isControlled) setInternalSel(next);
      onSelectionChange?.(next);
    },
    [interactive, isControlled, onSelectionChange, sel],
  );

  const instrumentProps: InstrumentProps = {
    e,
    interactive,
    isSelected,
    onToggle: toggle,
    mini,
  };

  const showApplyBar =
    !isControlled && interactive && onPaintSegments !== undefined && sel.length > 0;

  // `active`/`motionMeta` are computed above (before `e`) so the chassis
  // emission colors can be neutralized in the same pass; reused here for
  // the texture layer + caption.
  const motionSpec: MotionSpec | null =
    motionMeta && active ? classifyActiveMode(buildMotionActiveMode(state, active, motionMeta.kind), state.model ?? "") : null;
  const motionGeometry = motionMeta ? buildGeometry(state.model, mini ? "mini" : "full") : null;

  return (
    <div
      role="group"
      aria-label={`${name} live stage${interactive ? " — paint mode" : ""}`}
      className={cn(
        "relative select-none overflow-hidden rounded-stage border border-hairline bg-raised",
        className,
      )}
    >
      {zones !== null && state.model === "H6056" && zones === 6 ? (
        <BarsStage {...instrumentProps} />
      ) : zones !== null && state.model === "H6022" ? (
        <MatrixLampStage {...instrumentProps} segmentCount={zones} matrixCells={matrixCells} />
      ) : (
        <OrbStage e={e} socket={hasSocket(state.model)} mini={mini} />
      )}

      {/* §4.3 texture layer: a non-basic/non-off/non-unknown active.mode
          replaces the guessed flat color with the motion engine's real
          classification. One canvas per DeviceStage (§4.1's "one 2D
          context per stage"), screen-blended over the existing halo/lit
          layers rather than DOM-swapped into each instrument's own nested
          markup — MotionCanvas stays blank (transparent) whenever the
          driver's plate concurrency cap is hit, at which point the
          untouched layers beneath it are exactly today's fallback
          rendering, satisfying §4.1's "fall back to the existing cheap
          CSS Breath/Halo loop" without any extra branching here. */}
      {motionMeta && motionSpec && motionGeometry ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          // Edge softening lives in the geometry's clip paths, not here — the
          // engine draws into the instrument's silhouette, so the wrapper needs
          // no mask of its own.
          style={{ mixBlendMode: "screen" }}
        >
          <MotionCanvas
            geometry={motionGeometry}
            spec={motionSpec}
            variant={mini ? "mini" : "full"}
            className="h-full w-full"
          />
        </span>
      ) : null}

      {/* honest label/confidence/age caption + manual reset (§3.6/§4.3) —
          never rendered on the basic/off/unknown/no-active path, so that
          path stays byte-for-byte identical to pre-T12 output. */}
      {motionMeta && active ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <span
            className={cn(
              "truncate rounded-chip border border-hairline bg-bg/80 px-1.5 py-0.5 font-mono leading-none tracking-micro text-low",
              mini ? "text-[7px]" : "text-[9px]",
            )}
          >
            {activeModeCaption(active, motionMeta.label)}
          </span>
          {!mini ? (
            <span className="pointer-events-auto">
              <ActiveModeReset deviceRef={state.ref} />
            </span>
          ) : null}
        </div>
      ) : null}

      {/* §10 T27 — the inverse branch: no ledger record at all, so there is
          nothing honest to caption here (no label, no age, no motion
          texture — `motionMeta` is null for `unknown`). Deliberately gated
          on the opposite condition of the block above rather than a
          relaxed prop on `ActiveModeReset`: that control needs a KNOWN
          mode to reset FROM, this one needs the ABSENCE of one to fix
          TOWARD. The picker itself is full-stage only (mirroring
          `ActiveModeReset`'s own `!mini` gate) because the mini instrument
          is nested inside a `<Link>` on the dashboard card
          (`device-plate.tsx`) — a second interactive element in there
          would both be invalid HTML and hijack the card's navigation
          click. The honest "unknown" caption still shows at mini size, so
          the dashboard doesn't silently say nothing. */}
      {!motionMeta && active?.mode === "unknown" ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <span
            className={cn(
              "truncate rounded-chip border border-hairline bg-bg/80 px-1.5 py-0.5 font-mono leading-none tracking-micro text-low",
              mini ? "text-[7px]" : "text-[9px]",
            )}
          >
            unknown
          </span>
          {!mini ? (
            <span className="pointer-events-auto">
              <UnknownModeChooser deviceRef={state.ref} />
            </span>
          ) : null}
        </div>
      ) : null}

      {/* floating apply affordance for standalone (uncontrolled) paint mode */}
      <AnimatePresence>
        {showApplyBar ? (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={springStandard}
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
          >
            <Button
              variant="solid"
              size="sm"
              onClick={() => onPaintSegments?.(sel)}
            >
              paint {sel.length} segment{sel.length === 1 ? "" : "s"}
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
