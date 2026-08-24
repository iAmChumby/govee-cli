"use client";

/**
 * MusicPanel — firmware music mode (WEBUI_SPEC §4 GET/PUT music).
 *
 * Mode integers are per-model and always fetched from the sidecar. When the
 * model rejects the instance entirely (supported=false) the panel goes muted
 * with the device's own words. Auto-color and a fixed color are mutually
 * exclusive, mirroring the CLI: picking one clears the other.
 */

import * as React from "react";

import { api, type MusicMode } from "@/lib/api";
import { useApplyMutation, useMusicModes } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Odometer } from "@/components/ui/odometer";
import { Panel } from "@/components/ui/panel";
import { SectionLabel } from "@/components/ui/section-label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import {
  ChipRowSkeleton,
  CountChip,
  EmptyState,
  MiniSwatches,
  PanelFrame,
  QueryErrorLine,
  RowSkeleton,
  StaggerItem,
  StaggerList,
  queryErrorMessage,
} from "./shared";

interface MusicVars {
  mode: string;
  sensitivity: number;
  auto_color?: boolean;
  hex?: string;
}

export function MusicPanel({ deviceRef }: { deviceRef: string }) {
  const music = useMusicModes(deviceRef);

  return (
    <PanelFrame
      label="music mode"
      chips={
        music.data?.supported && music.data.modes.length > 0 ? (
          <CountChip count={music.data.modes.length} singular="mode" />
        ) : null
      }
    >
      {music.isError ? (
        <QueryErrorLine
          message={queryErrorMessage(music.error)}
          onRetry={() => void music.refetch()}
        />
      ) : null}

      {music.isLoading ? <MusicSkeleton /> : null}

      {music.data && !music.isError ? (
        !music.data.supported || music.data.modes.length === 0 ? (
          music.data.modes.length === 0 && music.data.supported ? (
            <EmptyState
              title="no modes reported"
              hint="the model claims music support but returned an empty mode table."
            />
          ) : (
            <UnsupportedMusic />
          )
        ) : (
          <MusicControls deviceRef={deviceRef} modes={music.data.modes} />
        )
      ) : null}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------ unsupported */

/** Muted panel carrying the device's verbatim rejection. */
function UnsupportedMusic() {
  return (
    <Panel className="rounded-card border-hairline bg-transparent p-4">
      <p className="text-[12px] font-medium leading-snug text-mid">
        Music mode is unsupported on this model
      </p>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-low">
        PUT /music → 400 &ldquo;devices not support this instance&rdquo; — the
        capability is advertised, the hardware refuses it.
      </p>
    </Panel>
  );
}

/* --------------------------------------------------------------- controls */

interface MusicControlsProps {
  deviceRef: string;
  modes: MusicMode[];
}

function MusicControls({ deviceRef, modes }: MusicControlsProps) {
  const [modeKey, setModeKey] = React.useState<string | null>(null);
  const [sensitivity, setSensitivity] = React.useState(60);
  const [autoColor, setAutoColor] = React.useState(true);
  const [hex, setHex] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);

  const effectiveMode = modeKey ?? modes[0]?.key ?? null;

  // Mutual exclusion mirrors the CLI semantics exactly.
  const pickHex = (next: string) => {
    setHex(next);
    setAutoColor(false);
  };
  const toggleAuto = (on: boolean) => {
    setAutoColor(on);
    if (on) setHex(null);
  };

  const applyMusic = useApplyMutation<MusicVars>(
    "music",
    ({ ref, vars }) => api.applyMusic(ref, vars),
    (v) =>
      `${v.mode} · sens ${v.sensitivity}${v.auto_color ? " · auto color" : v.hex ? ` · ${v.hex}` : ""}`,
  );

  const handleApply = () => {
    if (!effectiveMode) return;
    setApplying(true);
    applyMusic({
      ref: deviceRef,
      vars: {
        mode: effectiveMode,
        sensitivity,
        ...(autoColor ? { auto_color: true } : hex ? { hex } : {}),
      },
    })
      .catch(() => {
        /* error toast already surfaced by the mutation hook */
      })
      .finally(() => setApplying(false));
  };

  const summary = effectiveMode
    ? `${effectiveMode} · sens ${sensitivity}${autoColor ? " · auto color" : hex ? ` · ${hex}` : ""}`
    : "no mode selected";

  return (
    <StaggerList ariaLabel="Music controls">
      {/* modes */}
      <StaggerItem>
        <SectionLabel index="01" title="mode" />
        <div className="mt-3 flex flex-wrap gap-2">
          {modes.map((m) => {
            const active = m.key === effectiveMode;
            return (
              <button
                key={m.key}
                type="button"
                title={`mode ${m.value}`}
                aria-pressed={active}
                onClick={() => setModeKey(m.key)}
                className={cn(
                  "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] transition-colors duration-150",
                  active
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                )}
              >
                {m.key}
              </button>
            );
          })}
        </div>
      </StaggerItem>

      {/* sensitivity */}
      <StaggerItem className="mt-5 block">
        <SectionLabel index="02" title="sensitivity" />
        <div className="mt-3 flex items-center gap-4">
          <Slider
            value={sensitivity}
            min={0}
            max={100}
            step={1}
            onValueChange={setSensitivity}
            ariaLabel="Music sensitivity"
            showBubble
            className="flex-1"
          />
          <span className="w-[5ch] text-right">
            <Odometer value={sensitivity} pad={3} className="text-[13px] text-hi" />
          </span>
        </div>
      </StaggerItem>

      {/* color source */}
      <StaggerItem className="mt-5 block">
        <SectionLabel index="03" title="color source" />
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className="flex items-center gap-2.5">
            <Switch
              checked={autoColor}
              onCheckedChange={toggleAuto}
              ariaLabel="Auto color"
            />
            <span className="text-[11px] uppercase leading-none tracking-micro text-mid">
              auto
            </span>
          </span>
          <MiniSwatches
            activeHex={hex}
            onPick={pickHex}
            ariaGroupLabel="Fixed music color"
          />
          {hex ? (
            <span className="font-mono text-[10px] uppercase text-low">{hex}</span>
          ) : null}
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-low">
          auto color and a fixed color are mutually exclusive — picking one
          clears the other.
        </p>
      </StaggerItem>

      {/* apply footer */}
      <StaggerItem className="mt-5 block">
        <div className="flex items-center gap-3 border-t border-hairline pt-4">
          <span aria-live="polite" className="min-w-0 truncate font-mono text-[11px] text-mid">
            {summary}
          </span>
          <Button
            variant="solid"
            size="sm"
            className="ml-auto shrink-0"
            busy={applying}
            disabled={!effectiveMode}
            onClick={handleApply}
          >
            apply
          </Button>
        </div>
      </StaggerItem>
    </StaggerList>
  );
}

/* -------------------------------------------------------------- skeleton */

function MusicSkeleton() {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <ChipRowSkeleton />
      </div>
      <RowSkeleton />
      <RowSkeleton />
    </div>
  );
}
