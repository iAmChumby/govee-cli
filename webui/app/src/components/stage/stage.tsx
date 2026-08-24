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
import type { DeviceState, DeviceSummary } from "@/lib/api";
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

/* ==================================================================
   DeviceStage — the optical bench centerpiece (WEBUI_SPEC §5.4).

   Per-model faithful rendering driven entirely by live state:

     H6056  two vertical light bars — continuous glowing diffuser
            tubes on machined bases (zones 0-2 left, 3-5 right as
            invisible paint bands over each tube)
     H6022  table lamp — a fabric shade that glows from within:
            continuous cylindrical gradient, inner core, weave
            texture; the 15 zones are soft paint bands, never boxes
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

/** The single color the whole instrument is emitting right now. */
function useActiveHsl(state: DeviceState | DeviceSummary): Hsl {
  return React.useMemo<Hsl>(() => {
    if (state.color) return rgbToHsl(state.color.rgb);
    if (state.color_temp_k !== null && state.color_temp_k !== undefined) {
      return rgbToHsl(kelvinToRgb(state.color_temp_k));
    }
    return WARM_HSL;
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

const RULER_TICKS = [0, 7, 14];

function LampStage({
  zoneCount,
  e,
  interactive,
  isSelected,
  onToggle,
  mini,
}: InstrumentProps & { zoneCount: number }) {
  const indices = Array.from({ length: zoneCount }, (_, i) => i);
  const coreOpacity = useCoreOpacity(e.glow);

  return (
    <div
      className={cn(
        "relative flex h-full flex-col items-center justify-end",
        mini ? "pb-4" : "pb-14",
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

      {/* mono ruler — zone 0 at the bottom, matching paint indices */}
      {!mini ? (
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
      ) : null}

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

        {/* paint bands over the shade — reversed so zone 0 sits at the bottom */}
        <span aria-hidden className="absolute inset-0 flex flex-col-reverse">
          {indices.map((i) => (
            <ZoneBand
              key={i}
              index={i}
              interactive={interactive}
              selected={isSelected(i)}
              onToggle={onToggle}
              className="flex-1"
            />
          ))}
        </span>
      </div>

      {/* base foot */}
      <div
        className={cn(
          "-mt-px rounded-b-btn border border-hairline-strong bg-panel",
          mini ? "h-[6px] w-[76px]" : "h-[12px] w-[152px]",
        )}
      />

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

  const factor = brightnessGlow(state.brightness);
  const e: Emission = React.useMemo(
    () => ({
      glow,
      warm,
      lit: hslCss(emissionHsl(activeHsl, factor)),
      haloHsl: glowHsl(activeHsl),
      core: hslCss(withLightness(activeHsl, Math.min(activeHsl[2] + 30, 96))),
    }),
    [glow, warm, activeHsl, factor],
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
        <OrbStage e={e} socket={hasSocket(state.model)} mini={mini} />
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
