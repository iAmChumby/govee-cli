"use client";

import * as React from "react";
import { motion } from "motion/react";

import type { DeviceState } from "@/lib/api";
import { useDeviceControls } from "@/lib/queries";
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
import { panelIn } from "@/lib/motion";
import { SegmentsPanel } from "./segments-panel";
import { HexField, NativeColorInput, SwatchRow } from "./color-picker";
import { useTrailingCommit } from "./use-trailing-commit";
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

  return (
    <motion.section variants={panelIn} className="flex min-w-0 flex-col gap-5">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium leading-tight tracking-[-0.02em] text-hi">
          {name}
        </h1>
        {state.model ? <Chip tone="accent">{state.model}</Chip> : null}
        <Chip>{state.transport}</Chip>
        <HeaderPower refId={refId} state={state} />
      </div>

      {/* tab rail */}
      <Panel className="px-5 pb-5 pt-4">
        <Tabs defaultValue="light">
          <TabsList className="flex-wrap">
            <TabsTrigger value="light">Light</TabsTrigger>
            {caps?.segments ? <TabsTrigger value="segments">Segments</TabsTrigger> : null}
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

          {caps?.segments ? (
            <TabsContent value="segments">
              <SegmentsPanel refId={refId} state={state} />
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

function HeaderPower({ refId, state }: { refId: string; state: DeviceState }) {
  const controls = useDeviceControls();
  return (
    <div className="ml-auto flex items-center gap-2.5">
      <span className="text-[11px] uppercase tracking-micro text-low">
        {state.power === null ? "?" : state.power ? "on" : "off"}
      </span>
      <Switch
        checked={state.power === true}
        onCheckedChange={(on) => void controls.power({ ref: refId, vars: on })}
        ariaLabel={`Power ${state.name ?? refId}`}
      />
    </div>
  );
}

/* -------------------------------------------------------------- light tab */

function LightTab({ refId, state }: ControlDeckProps) {
  const controls = useDeviceControls();
  const caps = state.capabilities;

  /* --- brightness dial ---
     The Dial emits continuously and has no commit event, so display
     value tracks every change locally while the mutation rides a
     ~150ms trailing-edge throttle: drags emit at most one request per
     quiet window, and the final value always lands after release. */
  const [scrub, setScrub] = React.useState<number | null>(null);
  const lastSent = React.useRef<number | null>(null);
  const commitBrightness = useTrailingCommit((value: number) => {
    if (value === lastSent.current) return;
    lastSent.current = value;
    void controls.brightness({ ref: refId, vars: value });
  });
  // once the cache confirms a value, stop pinning the scrub
  React.useEffect(() => {
    if (scrub !== null && state.brightness === scrub) setScrub(null);
  }, [state.brightness, scrub]);

  /* --- temperature ---
     Radix gives us a real commit event here (drag end / keyboard);
     the kelvin ramp underlay shows what the numbers mean. */
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
    <div className="space-y-6 pt-5">
      {/* dial + power cluster */}
      <div className="flex flex-wrap items-center justify-around gap-6">
        <Dial
          value={brightnessDisplay}
          min={1}
          max={100}
          step={1}
          size={160}
          unit="%"
          label={`${state.name ?? refId} brightness`}
          onValueChange={(v) => {
            setScrub(v);
            commitBrightness(v);
          }}
        />

        <div className="min-w-[140px] space-y-4">
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
          <span className="font-mono text-[11px] tabular-nums text-mid">
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
              className="pointer-events-none absolute left-[9px] right-[9px] top-1/2 h-[3px] -translate-y-1/2 rounded-full"
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
          <span className="w-[9ch] text-right font-mono text-[10px] leading-none text-low">
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
  return (
    <div className="mt-5 flex items-center gap-4 border-t border-hairline pt-4">
      <span className="flex items-center gap-2">
        <StatusDot tone={online ? "ok" : "off"} />
        <span className="text-[11px] uppercase tracking-micro text-low">
          {online ? "online" : "offline"}
        </span>
      </span>

      <span aria-hidden className="h-3 w-px bg-hairline" />

      <span className="flex items-center gap-2 font-mono text-[11px] text-mid">
        {state.color ? (
          <>
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-chip border border-hairline"
              style={{ background: state.color.hex }}
            />
            {state.color.hex.toUpperCase()}
          </>
        ) : state.color_temp_k !== null ? (
          `${state.color_temp_k}K`
        ) : (
          "—"
        )}
      </span>

      <Chip className="ml-auto">{state.transport}</Chip>
    </div>
  );
}
