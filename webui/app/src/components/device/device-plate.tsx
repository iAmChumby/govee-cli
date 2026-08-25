"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";

import { Chip, Odometer, Panel, Slider, StatusDot, Switch } from "@/components/ui";
import { DeviceStage } from "@/components/stage/stage";
import { type Hsl } from "@/components/stage/color";
import type { DeviceSummary } from "@/lib/api";
import { useDeviceBleed } from "@/lib/device-bleed";
import { dominantHsl } from "@/lib/motion-engine/dominant-hsl";
import type { ActiveMode as MotionActiveMode } from "@/lib/motion-engine/types";
import { useDeviceControls, usePendingState } from "@/lib/queries";
import { springCelebrate } from "@/lib/motion";
import { cn } from "@/lib/cn";

/* ==================================================================
   DevicePlate — the dashboard's device card (extracted from page.tsx,
   V3_VISUAL_DIRECTION.md §D "Device card (dashboard)"). SIGNAL-SPILL
   for the card surface (useDeviceBleed drives --dev-hue/sat/light/alpha
   on the card root so background/border/ambient-shadow tint toward the
   live device color, §C), SIGNAL-PRIME for the instrument itself
   (DeviceStage, unmodified — owned by T12).
   ================================================================== */

/** Compact temperature presets — inside every registered model's range. */
export const TEMP_PRESETS = [2700, 4000, 6500] as const;

/** Six quick colors, shared with the device console's paint palette and
 *  the dashboard's group broadcast row (see groups-section.tsx). */
export const QUICK_COLORS = [
  "#FF4545",
  "#FFA53D",
  "#FFD23D",
  "#46D06A",
  "#3D7BFF",
  "#EAF2FF",
] as const;

/**
 * "The one colour this device is emitting right now", for the card's bleed.
 *
 * Delegates to the motion engine when a scene/DIY/music mode is playing,
 * because in that case the cloud's `color_temp_k` is a stale leftover: the
 * shelf lamp reports 2700K while visibly running blue-to-magenta blobs, and a
 * card that bled amber around a purple instrument reproduced the exact
 * mismatch this release exists to fix. Plain colour/temp readings are still
 * trustworthy, so those pass straight through.
 */
export function activeHsl(device: DeviceSummary): Hsl {
  const meta = motionModeMetaFor(device.active?.mode);
  return dominantHsl({
    color: device.color ? { rgb: device.color.rgb } : null,
    colorTempK: device.color_temp_k ?? null,
    motionMode: meta
      ? {
          kind: meta,
          name: device.active?.label ?? undefined,
          color: device.color
            ? { r: device.color.rgb[0], g: device.color.rgb[1], b: device.color.rgb[2] }
            : null,
          colorTempK: device.color_temp_k ?? null,
          confidence: device.active?.confidence ?? "unknown",
          ageSeconds: device.active?.age_seconds ?? null,
          source: "ui",
        }
      : null,
    model: device.model ?? "",
  });
}

/** api.ts's ledger `mode` onto the motion engine's own kind; null when nothing
 *  is playing (off / basic / unknown), which is the no-motion, no-guess case. */
function motionModeMetaFor(
  mode: DeviceSummary["active"]["mode"] | undefined,
): MotionActiveMode["kind"] | null {
  switch (mode) {
    case "scene":
      return "firmware_scene";
    case "diy":
      return "diy_scene";
    case "music":
      return "music_mode";
    case "snapshot":
      return "solid";
    case "segments":
      return "segment_paint";
    case "effect":
      return "effect";
    default:
      return null;
  }
}

const SPARK_ANGLES = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);

/**
 * Celebration moment #1 — "first light" (V3_VISUAL_DIRECTION.md §E).
 * Fires once per off→on power transition (see the effect in
 * `DevicePlate` — never on a poll tick, never on a routine re-render).
 * A fresh `id` remounts this component, replaying the burst; the burst
 * itself is a set of one-shot mount-time tweens, not a persistent
 * `requestAnimationFrame` subscriber — it does not touch the motion
 * engine's shared driver budget (spec §4.1).
 *
 * Reduced motion: skip the sparks, do one instant-feeling brightness
 * flash on the instrument instead (a plain CSS opacity transition, which
 * the app's global `prefers-reduced-motion` rule already collapses to
 * ~0ms — see globals.css).
 */
function FirstLightBurst({ id, reduced }: { id: number; reduced: boolean }) {
  if (reduced) {
    return (
      <span
        key={id}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-stage opacity-70 transition-opacity duration-150"
        style={{ backgroundColor: "hsl(var(--dev-hue) var(--dev-sat) 85%)" }}
        ref={(el) => {
          if (!el) return;
          requestAnimationFrame(() => {
            el.style.opacity = "0";
          });
        }}
      />
    );
  }
  return (
    <div
      key={id}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-stage"
      style={{ mixBlendMode: "screen" }}
    >
      {SPARK_ANGLES.map((angle, i) => (
        <motion.span
          key={i}
          className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -ml-[3px] -mt-[3px] rounded-full"
          style={{ backgroundColor: "hsl(var(--dev-hue) var(--dev-sat) 85%)" }}
          initial={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          animate={{
            opacity: 0,
            scale: 0.4,
            x: Math.cos(angle) * 46,
            y: Math.sin(angle) * 46,
          }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}

/**
 * Celebration moment #2 — "scene confirmed" (V3_VISUAL_DIRECTION.md §E).
 * Fires once when this device's ledger entry flips assumed→confirmed
 * (see the effect below) — a single ring-pulse around the card's
 * `.dev-bleed` border so a dashboard-initiated action visibly "arrives".
 * The toast half of this moment (Toasts, §D) lives in the mutation layer
 * that isn't this task's file; this is the card-side half only.
 *
 * Reduced motion: nothing to mount — the border color already jumps
 * instantly, since the `.dev-bleed` CSS transition it rides is already
 * collapsed to ~0ms by the global reduced-motion rule.
 */
function ConfirmPulse({ id, reduced }: { id: number; reduced: boolean }) {
  if (reduced) return null;
  return (
    <motion.span
      key={id}
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-panel border-2"
      style={{ borderColor: "hsl(var(--dev-hue) var(--dev-sat) var(--dev-light))" }}
      initial={{ opacity: 0.9, scale: 1 }}
      animate={{ opacity: 0, scale: 1.015 }}
      transition={springCelebrate}
    />
  );
}

type ViewTransitionDoc = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

/**
 * Stage-promotion View Transition (V3_VISUAL_DIRECTION.md §E) — the
 * card's mini instrument visually grows into the device console's hero
 * instrument on open. Shares `view-transition-name: stage-${ref}` with
 * the console page only while the transition is in flight (set via
 * inline style, cleared on completion), matching the mechanism
 * `ThemeToggle` already uses for the theme flip. Degrades to a plain
 * `Link` navigation whenever the API is unsupported, motion is reduced,
 * or the click is a modified click (new tab, etc.) — never intercepted
 * in those cases, so navigation itself can never break.
 *
 * Note: the device console page (owned by a different task) does not
 * yet mount a matching `view-transition-name` on its hero instrument, so
 * today this produces a graceful cross-fade rather than a true morph —
 * still a correct, non-broken degradation, and the true morph lands for
 * free once that page opts in.
 */
function useStagePromotion(ref: string, href: string) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const stageRef = React.useRef<HTMLAnchorElement>(null);

  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (
        reduced ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const doc = document as ViewTransitionDoc;
      if (typeof doc.startViewTransition !== "function") return;

      event.preventDefault();
      const el = stageRef.current;
      const name = `stage-${ref}`;
      const clear = () => {
        if (el) el.style.viewTransitionName = "";
      };
      try {
        if (el) el.style.viewTransitionName = name;
        const transition = doc.startViewTransition(() => {
          router.push(href);
        });
        void transition.finished.finally(clear);
      } catch {
        clear();
        router.push(href);
      }
    },
    [reduced, ref, href, router],
  );

  return { stageRef, onClick };
}

export function DevicePlate({ device }: { device: DeviceSummary }) {
  const controls = useDeviceControls();
  const pending = usePendingState(device.ref);
  const reduced = useReducedMotion();
  const [scrub, setScrub] = React.useState<number | null>(null);
  const brightness = scrub ?? device.brightness ?? 0;
  const name = device.name ?? device.ref;
  const href = `/device/${encodeURIComponent(device.ref)}`;

  const cardRef = React.useRef<HTMLDivElement>(null);
  const online = device.online !== false;
  const power = online && device.power === true;
  useDeviceBleed(cardRef, activeHsl(device), power, device.brightness ?? null);

  const { stageRef, onClick: onOpen } = useStagePromotion(device.ref, href);

  // Celebration #1 — "first light": off -> on, and only that transition.
  const prevPower = React.useRef(device.power);
  const [burstId, setBurstId] = React.useState(0);
  React.useEffect(() => {
    if (prevPower.current === false && device.power === true) {
      setBurstId((n) => n + 1);
    }
    prevPower.current = device.power;
  }, [device.power]);

  // Celebration #2 — "scene confirmed": the ledger catching up, assumed -> confirmed.
  const prevConfidence = React.useRef(device.active.confidence);
  const [confirmId, setConfirmId] = React.useState(0);
  React.useEffect(() => {
    if (prevConfidence.current === "assumed" && device.active.confidence === "confirmed") {
      setConfirmId((n) => n + 1);
    }
    prevConfidence.current = device.active.confidence;
  }, [device.active.confidence]);

  const commitBrightness = (value: number) => {
    setScrub(null);
    if (value !== device.brightness) {
      void controls.brightness({ ref: device.ref, vars: value });
    }
  };

  return (
    // Plain block wrapper carries the ref — the grid stretches this (a
    // direct grid item) to the row's height per the usual CSS Grid
    // default, and `Panel`'s own `h-full` fills that back down. `min-w-0`
    // is load-bearing, not decorative: without it, the channel-strip
    // dock's non-wrapping flex row (its buttons deliberately don't wrap —
    // that's what makes it a horizontal-scroll dock) contributes its full
    // unwrapped min-content width to this grid item's own automatic
    // minimum size, which silently grows the whole card — and therefore
    // the grid track, and the page — wider than the viewport. `min-w-0`
    // overrides that default so the item takes exactly the track's width
    // and the dock's own `overflow-x-auto` does the actual clipping.
    <div ref={cardRef} className="min-w-0">
      <Panel bleed className="relative h-full min-w-0 p-4">
        {confirmId > 0 ? <ConfirmPulse key={confirmId} id={confirmId} reduced={!!reduced} /> : null}

        <div className="flex items-center gap-2">
          <StatusDot tone={device.online === false ? "off" : "ok"} />
          {/* WEBUI_V3_SPEC.md §11.6 T33: this Link's laid-out box was
              79x15 — `leading-none` with no vertical padding — and it is
              one of only two ways into the device console. `min-w-11`
              floors the width for short names (e.g. "TV") and `py-4`
              floors the height at 15 (line-height:1 * 15px font) + 32 =
              47px, both under `pointer-coarse:` only, so a mouse never
              sees the row grow (§11.1's gate is inert to this by
              construction) and the parent row's `items-center` re-centers
              every sibling around the new, taller box — nothing shifts
              horizontally, so the grown box can't intrude into the power
              Switch's hit rectangle two items to the right. Padding on the
              element itself, not an oversized `::after` (§11.1): an
              overlay wider than the laid-out box would bleed into the
              Switch or the Chip instead of just making this link easier
              to hit. */}
          <Link
            href={href}
            className="truncate text-[15px] font-medium leading-none text-hi hover:underline hover:underline-offset-4 pointer-coarse:min-w-11 pointer-coarse:py-4"
          >
            {name}
          </Link>
          <Chip className="ml-auto">{device.model}</Chip>
          <Switch
            checked={device.power === true}
            onCheckedChange={(on) => void controls.power({ ref: device.ref, vars: on })}
            ariaLabel={`Power ${name}`}
            pending={pending}
            hue
          />
        </div>

        {/* live instrument — real proportions instead of a squeezed h-28,
            tap through to the full console */}
        <Link
          ref={stageRef}
          href={href}
          onClick={onOpen}
          aria-label={`Open ${name} console`}
          className="group/stage relative mt-3 block aspect-[4/3] rounded-stage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:aspect-[16/10]"
        >
          <DeviceStage
            state={device}
            variant="mini"
            className="h-full transition-colors duration-200 group-hover/stage:border-hairline-strong"
          />
          {burstId > 0 ? <FirstLightBurst key={burstId} id={burstId} reduced={!!reduced} /> : null}
        </Link>

        <div className="mt-3.5">
          <Slider
            value={brightness}
            min={1}
            max={100}
            onValueChange={setScrub}
            onValueCommit={commitBrightness}
            ariaLabel={`${name} brightness`}
            showBubble
            tint
          />
        </div>

        {/* live readouts — instrument-cluster digits, not footnotes (§F) */}
        <div className="mt-2.5 flex items-center justify-between">
          <Odometer value={brightness} pad={3} suffix="%" size="lg" className="text-hi" />
          <span className="flex items-center gap-2 font-mono text-[20px] leading-none text-mid">
            {device.color ? (
              <>
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 rounded-chip border border-hairline"
                  style={{ background: device.color.hex }}
                />
                {device.color.hex.toUpperCase()}
              </>
            ) : device.color_temp_k ? (
              <Odometer value={device.color_temp_k} suffix="K" size="lg" className="text-mid" />
            ) : (
              "—"
            )}
          </span>
        </div>

        {/* channel strip — quick color + temperature dock. At >=sm, one
            row that scrolls and masks exactly as before (§11.6 T33: "the
            row is untouched" at this width, because that's what the grid
            was designed around). Below sm the dock is 6 44px swatches
            with 8px gaps (304px) inside a ~310-324px content box, so the
            divider and all three temperature presets fell past the right
            edge on first paint — WEBUI_V3_SPEC.md §11.2 (1), "the user's
            screenshots show 270 sliced in half", the worst defect this
            round exists to fix. `max-sm:flex-wrap` lets 6 swatches fill
            row one and the divider + 3 presets fill row two instead, so
            nothing scrolls and nothing hides at that width; the mask
            that used to *hide* the cut only made sense while there was a
            cut to hide, so `max-sm:[mask-image:none]` (+ the -webkit-
            variant) turns it off there. The mask itself had to move out
            of `style` and into these two base utility classes to make
            that override possible at all: an inline `style` attribute
            beats any class selector's specificity regardless of media
            query, so a `max-sm:[mask-image:none]` *class* sitting next to
            a `style={{maskImage}}` prop would have compiled cleanly and
            done nothing on a real phone. */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto border-t border-hairline py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%_-_20px),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%_-_20px),transparent)] max-sm:flex-wrap max-sm:[mask-image:none] max-sm:[-webkit-mask-image:none]">
          {QUICK_COLORS.map((hex) => {
            const active = device.color?.hex.toUpperCase() === hex;
            return (
              <button
                key={hex}
                type="button"
                title={hex}
                aria-label={`Set ${name} to ${hex}`}
                aria-pressed={active}
                onClick={() => void controls.color({ ref: device.ref, vars: hex })}
                className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full active:scale-95"
              >
                <span
                  aria-hidden
                  className={cn(
                    "block h-6 w-6 rounded-full border transition-all duration-150",
                    active ? "border-[3px] scale-110" : "border-hairline hover:scale-110 hover:border-hairline-strong",
                  )}
                  style={{
                    background: hex,
                    borderColor: active ? hex : undefined,
                  }}
                />
              </button>
            );
          })}
          {/* Below sm the dock wraps (§11.6 T33), and this rule ends up as the
              last item on row one — a vertical hairline hard against the card's
              right edge, separating nothing from nothing. That is precisely the
              "looks cut off" reading the wrap was meant to eliminate, so it
              would have re-created the defect one row up. It is aria-hidden
              decoration, which §11.2 exempts by name from the no-hidden-elements
              rule: it carries no fact, and the wrap already does the separating
              it existed to do. At >=sm the row is one line and the rule still
              earns its place. */}
          <span aria-hidden className="mx-0.5 hidden h-6 w-px shrink-0 bg-hairline sm:block" />
          {TEMP_PRESETS.map((kelvin) => {
            const active = device.color_temp_k === kelvin;
            return (
              <button
                key={kelvin}
                type="button"
                aria-pressed={active}
                onClick={() => void controls.temperature({ ref: device.ref, vars: kelvin })}
                className={cn(
                  "flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-btn border px-3 font-mono text-[12px] leading-none transition-colors duration-150",
                  active
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-low hover:border-hairline-strong hover:text-hi",
                )}
              >
                {kelvin}
              </button>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
