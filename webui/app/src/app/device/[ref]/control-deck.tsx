"use client";

import * as React from "react";
import { motion } from "motion/react";

import type { DeviceState } from "@/lib/api";
import { useDeviceControls, usePendingState } from "@/lib/queries";
import {
  Chip,
  Dial,
  Odometer,
  Panel,
  SectionLabel,
  Slider,
  StatusDot,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { prefersColorTemp } from "@/components/stage/color";
import { panelIn } from "@/lib/motion";
import { PaintStudioPanel } from "./paint-studio/paint-studio-panel";
import { HexField, NativeColorInput, SwatchRow } from "./color-picker";
import {
  DiyPanel,
  EffectsPanel,
  MusicPanel,
  ScenesPanel,
  SnapshotsPanel,
  TogglesPanel,
} from "@/components/panels";

/* ==================================================================
    Control deck — device header + capability-gated tab rail.
    Light is always present; everything else appears only when the
    model advertises the capability. Feature panels own their Panel
    roots (phase E).
    ================================================================== */

interface ControlDeckProps {
  refId: string;
  state: DeviceState;
}

export function ControlDeck({ refId, state }: ControlDeckProps) {
  const caps = state.capabilities;
  const name = state.name ?? state.ref;
  const pending = usePendingState(refId);
  // Matrix Paint Studio (§5) replaces the old segment-select-then-apply
  // rail entirely for any model with an addressable matrix; a model
  // without one (H6008, matrix_rows=0) gets no segments/paint tab at all.
  const hasMatrix = (caps?.matrix_rows ?? 0) > 0;

  return (
    // T34 (WEBUI_V3_SPEC §11.6): gap-5 -> gap-3 below md trims part of the
    // chassis stack above the dial (header-to-panel rhythm); additive, so
    // >=md is untouched.
    // #10 landscape: gap-1 — on a landscape phone the fold is 295px tall
    // and every pixel between the header and the panel is a pixel the
    // dial does not get (measured; see reports/wave2-fix.md).
    <motion.section variants={panelIn} className="flex min-w-0 flex-col gap-5 max-md:gap-3 pointer-coarse:landscape:gap-1">
      {/* header */}
      {/* #10 landscape + the coarse-pointer wrap rule. The name no longer
          truncates: touch has no hover, so an ellipsis would hide the
          device's own name with no second channel to reveal it (CLAUDE.md).
          It gets its own full-width row (`basis-full`) so a long name wraps
          at the deck width instead of being squeezed into the ~97px left
          beside the chips; the chips and power switch take the next row.
          `leading-none` + `gap-y-1` claw back the height that second row
          costs (the column gap stays the wave-2 `gap-2`). Measured on the
          mock at 667×375 and 844×390: normal name
          dial 216–352, a 55-character name 234–370, both above the 375px
          fold. Every class is pointer-coarse:landscape:-gated, so desktop
          and portrait are untouched. The chips never shrink (a shrunk chip
          wraps its own text — "CLOUD-V2" broke over two lines). */}
      <div className="flex flex-wrap items-center gap-3 pointer-coarse:landscape:gap-2 pointer-coarse:landscape:gap-y-1">
        <h1 className="text-lg font-medium leading-tight tracking-display text-hi pointer-coarse:landscape:min-w-0 pointer-coarse:landscape:basis-full pointer-coarse:landscape:break-words pointer-coarse:landscape:leading-none">
          {name}
        </h1>
        {state.model ? (
          <Chip tone="accent" className="pointer-coarse:landscape:shrink-0">
            {state.model}
          </Chip>
        ) : null}
        <Chip className="pointer-coarse:landscape:shrink-0">{state.transport}</Chip>
        <HeaderPower refId={refId} state={state} pending={pending} />
      </div>

      {/* tab rail */}
      {/* #10 landscape: `pt-2` under pointer-coarse:landscape — the last chassis px
          that keeps the brightness dial inside a 667×375 first screen. */}
      <Panel className="px-4 pb-5 pt-4 max-md:pt-3 pointer-coarse:landscape:pt-1 pointer-coarse:landscape:px-4 sm:px-5">
        <Tabs defaultValue="light">
          {/* #10 landscape: the rail scrolls instead of wrapping, exactly as
              it does on a portrait phone (tabs.tsx's own rule: "Scrolls
              rather than wraps … keeps every label whole and reachable").
              At 667px the deck column is 316px and the rail's six
              triggers are ~480px of text, so `sm:flex-wrap` stacked them
              four deep — 173px of rail above the dial, more than the dial
              itself. One scrolling row is 45px. The rail keeps its live
              edge fade (tabs.tsx's `useEdgeScroll`), so the overflow is
              announced as an affordance rather than as a clipped label. */}
          <TabsList className="-mx-1 overflow-x-auto px-1 sm:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pointer-coarse:landscape:flex-nowrap">
            <TabsTrigger value="light">Light</TabsTrigger>
            {hasMatrix ? <TabsTrigger value="paint-studio">Paint Studio</TabsTrigger> : null}
            {caps?.scenes ? <TabsTrigger value="scenes">Scenes</TabsTrigger> : null}
            {caps?.diy ? <TabsTrigger value="diy">DIY</TabsTrigger> : null}
            {caps?.diy ? <TabsTrigger value="snapshots">Snapshots</TabsTrigger> : null}
            {caps?.music ? <TabsTrigger value="music">Music</TabsTrigger> : null}
            {(caps?.toggles.length ?? 0) > 0 ? (
              <TabsTrigger value="toggles">Toggles</TabsTrigger>
            ) : null}
            {caps?.prefer_ble_effects ? <TabsTrigger value="effects">Effects</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="light">
            <LightTab refId={refId} state={state} />
          </TabsContent>

          {hasMatrix ? (
            <TabsContent value="paint-studio">
              <PaintStudioPanel refId={refId} state={state} />
            </TabsContent>
          ) : null}

          {caps?.scenes ? (
            <TabsContent value="scenes">
              <ScenesPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
          {caps?.diy ? (
            <TabsContent value="diy">
              <DiyPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
          {caps?.diy ? (
            <TabsContent value="snapshots">
              <SnapshotsPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
          {caps?.music ? (
            <TabsContent value="music">
              <MusicPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
          {(caps?.toggles.length ?? 0) > 0 ? (
            <TabsContent value="toggles">
              <TogglesPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
          {caps?.prefer_ble_effects ? (
            <TabsContent value="effects">
              <EffectsPanel deviceRef={refId} />
            </TabsContent>
          ) : null}
        </Tabs>

        <ReadoutStrip state={state} />
      </Panel>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ power */

function HeaderPower({ refId, state, pending }: { refId: string; state: DeviceState; pending: boolean }) {
  const controls = useDeviceControls();
  return (
    <div className="ml-auto flex items-center gap-2.5">
      <span className="text-data uppercase tracking-micro text-low">
        {pending ? "syncing" : state.power === null ? "?" : state.power ? "on" : "off"}
      </span>
      <Switch
        checked={state.power === true}
        onCheckedChange={(on) => void controls.power({ ref: refId, vars: on })}
        ariaLabel={`Power ${state.name ?? refId}`}
        pending={pending}
      />
    </div>
  );
}

/* -------------------------------------------------------------- light tab */

function LightTab({ refId, state }: ControlDeckProps) {
  const controls = useDeviceControls();
  const caps = state.capabilities;

  /* --- brightness dial ---
     `onValueChange` fires on every tick of a drag and only ever updates
     `scrub` — the dial, the odometer and the 3D stage all read from it,
     so the instrument tracks the finger with zero lag, but nothing here
     reaches the network. The Dial's `onValueCommit` (see dial.tsx) is
     the one real "send it" event: it fires once per settled gesture
     (drag release, or a coalesced keyboard/wheel run), so this needs no
     debounce of its own — that used to live here as a bare ~150ms
     trailing-edge throttle fed by `onValueChange`, which is exactly what
     let a mid-drag pause (routine on a 3-second drag) fire early and
     send a real command to a real light before the user let go. */
  const [scrub, setScrub] = React.useState<number | null>(null);
  const lastSent = React.useRef<number | null>(null);
  const commitBrightness = React.useCallback(
    (value: number) => {
      // Deliberately does NOT also skip when `value === state.brightness`.
      // That looks like a free saving and is not: `state.brightness` is the
      // optimistically-updated cache, not the device. If a command was applied
      // optimistically but never actually landed, the cache reads the value the
      // user asked for while the lamp sits at the old one — and skipping on it
      // would leave no way to re-issue that exact value at all, short of moving
      // the dial away and back. One redundant request is the cheaper mistake,
      // and it only happens when a person deliberately re-commits a value.
      if (value === lastSent.current) return;
      lastSent.current = value;
      void controls.brightness({ ref: refId, vars: value });
    },
    [controls, refId],
  );
  // once the cache confirms a value, stop pinning the scrub
  React.useEffect(() => {
    if (scrub !== null && state.brightness === scrub) setScrub(null);
  }, [state.brightness, scrub]);

  /* --- temperature ---
     `onValueCommit` fires once per settled gesture — a real drag release
     from Radix, or a coalesced keyboard run now that `slider.tsx` itself
     buffers repeated keystep commits and flushes on keyup (audited: this
     call site never needed its own debounce, because it only ever wired
     the commit event, never `onValueChange`, to the network — the bug
     was Radix firing that event once per keydown-repeat, fixed once,
     inside `Slider`, for every consumer at once). The kelvin ramp
     underlay shows what the numbers mean. */
  const tempMin = caps?.temp_min ?? 2700;
  const tempMax = caps?.temp_max ?? 6500;
  const [tempScrub, setTempScrub] = React.useState<number | null>(null);
  const tempValue = tempScrub ?? state.color_temp_k ?? Math.round((tempMin + tempMax) / 2 / 50) * 50;

  const commitTemperature = (kelvin: number) => {
    setTempScrub(null);
    if (kelvin !== state.color_temp_k) {
      void controls.temperature({ ref: refId, vars: kelvin });
    }
  };

  /* --- color --- */
  const commitColor = React.useCallback(
    (hex: string) => {
      void controls.color({ ref: refId, vars: hex });
    },
    [controls, refId],
  );

  const brightnessDisplay = scrub ?? state.brightness ?? 50;

  return (
    // T34: pt-5 -> pt-3 and space-y-6 -> space-y-4 below md are chassis
    // trims (the gap stack §11.6 calls out); pt-5 is the last bit of space
    // above the dial itself, space-y-6 only affects sections *below* it.
    // #10 landscape: pt-1 under pointer-coarse:landscape — the last
    // chassis pixel between the tab rail's underline and the dial.
    <div className="space-y-6 max-md:space-y-4 pt-5 max-md:pt-3 pointer-coarse:landscape:pt-1">
      {/*
        T34: this row used to be `justify-around` with a fixed 160px Dial
        plus a `min-w-space-140` column at `gap-6` (24px) — 160+24+140=324
        against the panel's ~310px content box at 390px, so it wrapped by
        accident a few px past the threshold. `justify-around` then spread
        a lone Dial across the first line with uneven space, and the
        column's wrapped second line was what pushed the inline power
        switch 10px past `main`'s visible bottom edge (measured, see
        §11.6 T34). Below md this is now nowrap-by-construction: gap-4
        (16px) + a 120px column floor = 160+16+120=296, comfortably under
        310 with margin for the column's actual (wider) content, so the
        cluster never exceeds the Dial's own 160px row height and nothing
        downstream of it gets shoved off-screen. `shrink-0` on the Dial
        keeps the instrument (§G's loudest element) from ever being the
        thing that gives when space is tight.
      */}
      <div className="flex flex-wrap items-center justify-around gap-6 max-md:flex-nowrap max-md:justify-between max-md:gap-4">
        <Dial
          value={brightnessDisplay}
          min={1}
          max={100}
          step={1}
          size={160}
          unit="%"
          label={`${state.name ?? refId} brightness`}
          // #10 landscape: 136px instead of 160. The dial is the one
          // element in this column whose size is a free parameter — the
          // tab rail's 44px, the power switch's 44px and the back link's
          // 49px are all pinned by the app's own 44px touch-target floor
          // — and at 667×375 the fold is 295px tall. 136 is still a
          // 136px target; 160 does not fit (measured; see
          // reports/wave2-fix.md).
          className="max-md:shrink-0 pointer-coarse:landscape:[--dial-size:136px]"
          onValueChange={setScrub}
          onValueCommit={commitBrightness}
        />

        <div className="min-w-space-140 max-md:min-w-space-120 space-y-4">
          <SectionLabel index="01" title="power" />
          <div className="flex items-center gap-4">
            <Switch
              checked={state.power === true}
              onCheckedChange={(on) => void controls.power({ ref: refId, vars: on })}
              ariaLabel={`Power ${state.name ?? refId}`}
            />
            <Odometer
              value={brightnessDisplay}
              pad={3}
              suffix="%"
              className="text-lg text-hi"
            />
          </div>
        </div>
      </div>

      {/* temperature */}
      <div>
        <div className="flex items-baseline justify-between">
          <SectionLabel index="02" title="temperature" />
          <span className="font-mono text-data tabular-nums text-mid">
            {tempScrub !== null || state.color_temp_k !== null
              ? `${Math.round(tempValue)}K`
              : "—"}
          </span>
        </div>
        <div className="relative mt-3 flex items-center gap-4">
          <div className="relative flex-1">
            {/* kelvin ramp underlay: warm → white → cool, behind the track */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-space-9 right-space-9 top-1/2 h-space-3 -translate-y-1/2 rounded-full"
              style={{
                background: "linear-gradient(90deg, #FFB46B, #FFFFFF, #BBD8FF)",
              }}
            />
            <Slider
              value={tempValue}
              min={tempMin}
              max={tempMax}
              step={50}
              ariaLabel="Color temperature"
              onValueChange={setTempScrub}
              onValueCommit={commitTemperature}
            />
          </div>
          {/* #16: the range (e.g. "2700–6500") is nine monospace glyphs. At
              the 12px data rung they need 64.83px and the old `w-[9ch]` box
              was 64.80px — short by 0.03px, so the label wrapped to two
              lines. `w-max` sizes the box to the text it holds, so it can
              never wrap and the constant never has to be re-derived when
              the type moves again; the slider gets the width back instead
              of the type being shrunk to fit a hand-counted box. */}
          <span className="w-max text-right font-mono text-data leading-none text-low">
            {tempMin}–{tempMax}
          </span>
        </div>
      </div>

      {/* color well */}
      <div>
        <SectionLabel index="03" title="color" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SwatchRow
            activeHex={state.color?.hex ?? null}
            onPick={commitColor}
            ariaGroupLabel="Device colors"
          />
          <NativeColorInput value={state.color?.hex ?? "#FFFFFF"} onPick={commitColor} />
          <HexField onCommit={commitColor} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- readout strip */

function ReadoutStrip({ state }: { state: DeviceState }) {
  const online = state.online !== false;
  // A device in colour-temperature mode reports a placeholder white in
  // `color`; printing that hex would contradict the stage beside it, which
  // now paints the temperature (see `basicHsl`).
  const asTemp =
    state.color_temp_k !== null && prefersColorTemp(state.color?.rgb ?? null, state.color_temp_k);
  return (
    <div className="mt-5 flex items-center gap-4 border-t border-hairline pt-4">
      <span className="flex items-center gap-2">
        <StatusDot tone={online ? "ok" : "off"} />
        <span className="text-data uppercase tracking-micro text-low">
          {online ? "online" : "offline"}
        </span>
      </span>

      <span aria-hidden className="h-3 w-px bg-hairline" />

      <span className="flex items-center gap-2 font-mono text-data text-mid">
        {asTemp ? (
          `${state.color_temp_k}K`
        ) : state.color ? (
          <>
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-chip border border-hairline"
              style={{ background: state.color.hex }}
            />
            {state.color.hex.toUpperCase()}
          </>
        ) : (
          "—"
        )}
      </span>

      <Chip className="ml-auto">{state.transport}</Chip>
    </div>
  );
}
