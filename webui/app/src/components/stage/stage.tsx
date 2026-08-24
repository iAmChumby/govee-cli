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

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";
import type { DeviceState } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  clamp,
  hslCss,
  hslaCss,
  kelvinToRgb,
  rgbToHsl,
  withLightness,
  type Hsl,
} from "./color";

/* ==================================================================
   DeviceStage — the optical bench centerpiece (WEBUI_SPEC §5.4).

   Per-model faithful rendering driven entirely by live state:

     H6056  two vertical tri-zone bars standing on machined bases
            (zones 0-2 left top→bottom, 3-5 right top→bottom)
     H6022  table-lamp silhouette — domed shade column, 15 vertical
            zones ordered bottom→top, mono ruler along the left edge
     H6008  single orb bulb with a three-layer halo and socket collar
     other  generic single orb

   Nothing snaps, ever: halo opacity/scale ride JS springs through the
   registered --glow-alpha / --glow-scale custom properties, zone wells
   crossfade into lit color on the same spring, and an idle breath
   oscillates the halo ±4% unless prefers-reduced-motion asks otherwise.

   Paint mode: pass `interactive` to make zones toggleable buttons.
   Selection is controlled (`selected` + `onSelectionChange`) or, when
   the parent doesn't own it, internal — in which case a floating apply
   affordance appears and fires `onPaintSegments(indices)`.
   ================================================================== */

export interface DeviceStageProps {
  state: DeviceState;
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
  className?: string;
}

/** Warm incandescent default when the device reports neither color nor temp. */
const DEFAULT_LIGHT_HSL: Hsl = [38, 90, 66];

/** Physical truth per model — what the hardware actually shows. */
function zoneCountFor(state: DeviceState): number | null {
  if (state.model === "H6056") return 6;
  if (state.model === "H6022") return state.capabilities?.segment_count_cloud ?? 15;
  return null; // orb models (H6008) and unknowns
}

function hasSocket(model: string | null): boolean {
  return model === "H6008";
}

/** Brightness as a 0..1 emission factor with a visible floor. */
function brightnessGlow(brightness: number | null): number {
  return 0.25 + 0.75 * (clamp(brightness ?? 50, 1, 100) / 100);
}

/** The single color the whole instrument is emitting right now. */
function useActiveHsl(state: DeviceState): Hsl {
  return React.useMemo<Hsl>(() => {
    if (state.color) return rgbToHsl(state.color.rgb);
    if (state.color_temp_k !== null && state.color_temp_k !== undefined) {
      return rgbToHsl(kelvinToRgb(state.color_temp_k));
    }
    return DEFAULT_LIGHT_HSL;
  }, [state.color, state.color_temp_k]);
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

/** Halo light color — lifted so even deep reported colors still read as light. */
function glowHsl(hsl: Hsl): Hsl {
  return [hsl[0], hsl[1], Math.max(hsl[2], 58)];
}

/* ------------------------------------------------------------------ atoms */

/**
 * Idle breath: ±4% opacity oscillation over ~7s. Renders children
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
        className="absolute inset-0 block blur-2xl will-change-transform"
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

interface ZoneProps {
  index: number;
  hsl: Hsl;
  glow: MotionValue<number>;
  interactive: boolean;
  selected: boolean;
  onToggle?: (index: number) => void;
  className?: string;
}

/**
 * One addressable zone: a permanent neutral well (bg-accent-dim) with a
 * lit color layer whose opacity rides the glow spring — power-off is a
 * continuous fade to the well, never a class flip. Interactive zones are
 * real buttons with aria-pressed; selection shows as an inset accent ring.
 */
function Zone({ index, hsl, glow, interactive, selected, onToggle, className }: ZoneProps) {
  const lit = hslCss(hsl);

  const inner = (
    <>
      {/* neutral well — always present, the zone's off state */}
      <span aria-hidden className="absolute inset-0 rounded-[inherit] bg-accent-dim" />
      {/* lit color — fades in/out on the glow spring */}
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-[inherit] transition-[background-color] duration-[240ms] [transition-timing-function:var(--ease-out-soft)]"
        style={{ opacity: glow, background: lit }}
      />
      {/* selection ring — mounted always, faded on a spring */}
      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: selected ? 1 : 0 }}
        transition={springStandard}
        className="absolute inset-0 rounded-[inherit] border-2 border-accent"
      />
    </>
  );

  if (!interactive) {
    return (
      <div className={cn("relative min-h-0", className)} aria-hidden>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Segment ${index}`}
      onClick={() => onToggle?.(index)}
      className={cn(
        "group relative min-h-0 cursor-pointer outline-none",
        "after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-transparent",
        "after:transition-colors after:duration-150 hover:after:border-hairline-strong",
        className,
      )}
    >
      {inner}
    </button>
  );
}

/* ------------------------------------------------------------- H6056 bars */

interface InstrumentProps {
  hsl: Hsl;
  glow: MotionValue<number>;
  interactive: boolean;
  isSelected: (index: number) => boolean;
  onToggle: (index: number) => void;
}

function LightBar({ zones, hsl, glow, interactive, isSelected, onToggle }: InstrumentProps & { zones: [number, number, number] }) {
  const g = glowHsl(hsl);
  return (
    <div className="relative flex flex-col items-center">
      {/* halo behind the tube */}
      <Halo
        glow={glow}
        strength={0.65}
        background={`radial-gradient(closest-side, ${hslaCss(g, 0.6)}, transparent 72%)`}
        className="-inset-x-14 -top-24 bottom-6"
      />
      {/* glass tube: recessed cavity holding three zones */}
      <div className="relative flex h-[204px] w-[27px] flex-col gap-[3px] rounded-[13px] border border-hairline-strong bg-bg p-[3px]">
        {zones.map((i) => (
          <Zone
            key={i}
            index={i}
            hsl={hsl}
            glow={glow}
            interactive={interactive}
            selected={isSelected(i)}
            onToggle={onToggle}
            className="flex-1 rounded-[9px]"
          />
        ))}
      </div>
      {/* machined base */}
      <div className="mt-[7px] flex h-[13px] w-[58px] items-start justify-center rounded-btn border border-hairline-strong bg-panel">
        <span aria-hidden className="mt-[3px] h-px w-[70%] bg-hairline-strong" />
      </div>
    </div>
  );
}

function BarsStage(props: InstrumentProps) {
  const g = glowHsl(props.hsl);
  return (
    <div className="relative flex h-full items-end justify-center gap-16 pb-16">
      {/* floor reflection between the bases */}
      <Halo
        glow={props.glow}
        strength={0.28}
        background={`linear-gradient(to bottom, ${hslaCss(g, 0.35)}, transparent 85%)`}
        className="bottom-3 left-1/2 h-9 w-[300px] -translate-x-1/2 blur-md"
      />
      {/* ambient wash above the pair */}
      <Breath>
        <Halo
          glow={props.glow}
          strength={0.22}
          background={`radial-gradient(closest-side, ${hslaCss(g, 0.4)}, transparent 70%)`}
          className="left-1/2 top-2 h-40 w-[420px] -translate-x-1/2 blur-3xl"
        />
      </Breath>

      <LightBar {...props} zones={[0, 1, 2]} />
      <LightBar {...props} zones={[3, 4, 5]} />
    </div>
  );
}

/* ------------------------------------------------------------- H6022 lamp */

const RULER_TICKS = [0, 7, 14];

function LampStage({ zoneCount, ...props }: InstrumentProps & { zoneCount: number }) {
  const g = glowHsl(props.hsl);
  const indices = Array.from({ length: zoneCount }, (_, i) => i);

  return (
    <div className="relative flex h-full flex-col items-center justify-end pb-14">
      <Breath>
        {/* dome glow escaping the top of the shade */}
        <Halo
          glow={props.glow}
          strength={0.6}
          background={`radial-gradient(closest-side, ${hslaCss(g, 0.55)}, transparent 70%)`}
          className="left-1/2 top-4 h-44 w-[340px] -translate-x-1/2 blur-2xl"
        />
        {/* side spill down the shade flanks */}
        <Halo
          glow={props.glow}
          strength={0.35}
          background={`radial-gradient(closest-side, ${hslaCss(g, 0.4)}, transparent 72%)`}
          className="bottom-16 left-1/2 h-[280px] w-[260px] -translate-x-1/2 blur-2xl"
        />
      </Breath>

      {/* mono ruler — zone 0 at the bottom, matching paint indices */}
      <div
        aria-hidden
        className="absolute bottom-14 left-[16%] top-10 hidden flex-col justify-between items-end sm:flex"
      >
        {[...RULER_TICKS].reverse().map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] leading-none text-low">{t}</span>
            <span className="h-px w-2 bg-hairline-strong" />
          </span>
        ))}
      </div>

      {/* shade column: domed top, zones wound bottom→top */}
      <div className="relative flex h-[238px] w-[112px] flex-col-reverse gap-[2px] overflow-hidden rounded-t-[56px] rounded-b-[14px] border border-hairline-strong bg-bg p-[6px]">
        {indices.map((i) => (
          <Zone
            key={i}
            index={i}
            hsl={props.hsl}
            glow={props.glow}
            interactive={props.interactive}
            selected={props.isSelected(i)}
            onToggle={props.onToggle}
            className="flex-1 rounded-[3px]"
          />
        ))}
      </div>
      {/* base foot */}
      <div className="-mt-px h-[12px] w-[152px] rounded-b-btn border border-hairline-strong bg-panel" />

      {/* floor reflection */}
      <Halo
        glow={props.glow}
        strength={0.25}
        background={`linear-gradient(to bottom, ${hslaCss(g, 0.32)}, transparent 85%)`}
        className="bottom-3 left-1/2 h-8 w-[220px] -translate-x-1/2 blur-md"
      />
    </div>
  );
}

/* ------------------------------------------------------------------- orbs */

function OrbStage({ hsl, glow, socket }: { hsl: Hsl; glow: MotionValue<number>; socket: boolean }) {
  const g = glowHsl(hsl);
  const core = hslCss(withLightness(hsl, Math.min(hsl[2] + 28, 97)));
  const body = hslCss(hsl);
  const rim = hslCss(withLightness(hsl, Math.max(hsl[2] - 18, 8)));

  return (
    <div className="relative flex h-full flex-col items-center justify-center">
      <Breath>
        {/* outer halo */}
        <Halo
          glow={glow}
          strength={0.4}
          background={`radial-gradient(closest-side, ${hslaCss(g, 0.45)}, transparent 70%)`}
          className="left-1/2 top-1/2 h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 blur-3xl"
        />
        {/* mid halo */}
        <Halo
          glow={glow}
          strength={0.65}
          background={`radial-gradient(closest-side, ${hslaCss(g, 0.6)}, transparent 72%)`}
          className="left-1/2 top-1/2 h-[190px] w-[190px] -translate-x-1/2 -translate-y-1/2 blur-xl"
        />
      </Breath>

      <div className="relative flex flex-col items-center">
        {/* orb: permanent well + lit sphere fading in on the glow spring */}
        <div className="relative h-[108px] w-[108px]">
          <span aria-hidden className="absolute inset-0 rounded-full border border-hairline bg-accent-dim" />
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border border-hairline-strong transition-[background] duration-[240ms] [transition-timing-function:var(--ease-out-soft)]"
            style={{
              opacity: glow,
              background: `radial-gradient(circle at 36% 30%, ${core}, ${body} 55%, ${rim} 100%)`,
            }}
          />
        </div>
        {socket ? (
          <>
            <div className="-mt-1 h-[11px] w-[34px] rounded-b-chip border border-hairline-strong bg-panel" />
            <div className="h-[6px] w-[54px] rounded-b-btn border-x border-b border-hairline-strong bg-panel" />
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
  className,
}: DeviceStageProps) {
  const isControlled = selected !== undefined;
  const [internalSel, setInternalSel] = React.useState<number[]>([]);
  const sel = selected ?? internalSel;

  const hsl = useActiveHsl(state);
  const glow = useGlow(state.power === true, state.brightness);
  const zones = zoneCountFor(state);
  const name = state.name ?? state.ref;

  const isSelected = React.useCallback(
    (i: number) => sel.includes(i),
    [sel],
  );

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
    hsl,
    glow,
    interactive,
    isSelected,
    onToggle: toggle,
  };

  const showApplyBar =
    !isControlled && interactive && onPaintSegments !== undefined && sel.length > 0;

  return (
    <div
      role="group"
      aria-label={`${name} live stage${interactive ? " — paint mode" : ""}`}
      className={cn(
        "relative select-none overflow-hidden rounded-stage border border-hairline bg-raised",
        className,
      )}
    >
      {zones !== null ? (
        zones === 6 && state.model === "H6056" ? (
          <BarsStage {...instrumentProps} />
        ) : (
          <LampStage {...instrumentProps} zoneCount={zones} />
        )
      ) : (
        <OrbStage hsl={hsl} glow={glow} socket={hasSocket(state.model)} />
      )}

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
