"use client";

/**
 * MusicPanel — firmware music mode (WEBUI_SPEC §4 GET/PUT music).
 *
 * Mode integers are per-model and always fetched from the sidecar. When the
 * model rejects the instance entirely (supported=false) the panel goes muted
 * with the device's own words. Auto-color and a fixed color are mutually
 * exclusive, mirroring the CLI: picking one clears the other.
 *
 * Two things this panel used to get wrong, both fixed here:
 *
 * 1. The colour-source switch is not a free-floating toggle with an implicit
 *    "off means nothing" state. The CLI's `--no-auto-color` with no `--color`
 *    is a real, distinct command (govee_cli/commands/music.py) that sends an
 *    explicit `autoColor: 0` and leaves the device on manual/last colour. The
 *    apply payload below always sends `auto_color` matching the switch's
 *    current position — never omitted — because omitting it on "off, no
 *    colour picked" collapsed to `{}`, which is wire-identical to the user
 *    never having touched the switch at all.
 * 2. `/device/state` cannot tell you what music mode is running (PROJECT
 *    LAW), but the ledger's `active.label` can, when `active.mode ===
 *    "music"` — govee_cli/commands/music.py and webui/api/routers/scenes.py
 *    both write it on every apply. Sensitivity and colour source are NOT
 *    recoverable, though: the ledger records them in `entry.payload` but
 *    `webui/api/deps.py`'s `_entry_active()` never serializes that back to
 *    the wire. So the mode chip seeds from the ledger when it can; the rest
 *    of the form stays visibly a form, not a readout.
 */

import * as React from "react";

import { api, type ActiveMode, type MusicMode } from "@/lib/api";
import { useApplyMutation, useDeviceState, useMusicModes } from "@/lib/queries";
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
  auto_color: boolean;
  hex?: string;
}

/**
 * Builds the PUT payload from the panel's own visible state. `auto_color` is
 * always present — never conditionally spread away — because the sidecar
 * (and `govee_cli/http_v2.set_music_mode`) treats an omitted `autoColor` as
 * "don't touch colour source", which is indistinguishable from a switch the
 * user never touched. "Off with no colour picked" is still meaningful: it
 * mirrors the CLI's `--no-auto-color` with no `--color`, so it is sent as
 * `auto_color: false` with no `hex`, not swallowed into `{}`.
 */
export function buildMusicPayload(
  mode: string,
  sensitivity: number,
  autoColor: boolean,
  hex: string | null,
): MusicVars {
  return {
    mode,
    sensitivity,
    auto_color: autoColor,
    ...(!autoColor && hex ? { hex } : {}),
  };
}

/**
 * The mode key to seed the form with, or `null` when there is no honest
 * basis for one (PROJECT LAW: unknown stays unknown, never a plausible
 * guess). A ledger entry only counts when it says this device is actually
 * in `music` mode AND its label is one of `modes` — a stale label from a
 * model swap, or a label from some other mode, seeds nothing.
 */
export function seedModeKeyFromLedger(
  active: Pick<ActiveMode, "mode" | "label"> | null | undefined,
  modes: MusicMode[],
): string | null {
  if (!active || active.mode !== "music" || !active.label) return null;
  return modes.some((m) => m.key === active.label) ? active.label : null;
}

/**
 * The caption under the mode rail. It may claim ledger provenance ONLY for
 * the mode the rail is actually highlighting.
 *
 * The bug this prevents: deriving the caption from `ledgerModeKey` alone.
 * That value is recomputed from props and does not change when the user
 * clicks a chip, so once the form had been seeded, "mode seeded from the
 * ledger's last commanded value (confirmed)" stayed on screen underneath a
 * mode the user had since picked by hand — the console attributing a user's
 * unsent choice to the device record. The same wrong caption also showed on
 * the render before the seeding effect runs, where the highlighted mode is
 * just `modes[0]`.
 */
export function modeProvenanceNote(
  ledgerModeKey: string | null,
  effectiveMode: string | null,
  confidence: ActiveMode["confidence"] | null,
): string {
  if (ledgerModeKey === null) {
    return "no usable ledger record for this device's music mode — every field below is this form's own default, not a readout of what's running now.";
  }
  if (ledgerModeKey === effectiveMode) {
    return `mode seeded from the ledger's last commanded value (${confidence}) — sensitivity and colour source below are not recorded there, so they default to this form's own starting point, not a readout of what's running now.`;
  }
  return `the highlighted mode is not the ledger's — its last commanded mode for this device is "${ledgerModeKey}" (${confidence}). Nothing below is a readout of what's running now.`;
}

export function MusicPanel({ deviceRef }: { deviceRef: string }) {
  const music = useMusicModes(deviceRef);
  const deviceState = useDeviceState(deviceRef);
  const active = deviceState.data?.active ?? null;

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
          <MusicControls deviceRef={deviceRef} modes={music.data.modes} active={active} />
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
  active: ActiveMode | null;
}

function MusicControls({ deviceRef, modes, active }: MusicControlsProps) {
  const [modeKey, setModeKeyState] = React.useState<string | null>(null);
  const [sensitivity, setSensitivity] = React.useState(60);
  const [autoColor, setAutoColor] = React.useState(true);
  const [hex, setHex] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);

  // Seeding is one-shot and yields to the user the moment they touch the
  // mode rail. Without `seedAttempted`, a device-state query that resolves
  // AFTER the user has already picked a mode would silently overwrite their
  // choice the next time this effect re-runs.
  const seedAttempted = React.useRef(false);
  const setModeKey = (key: string) => {
    seedAttempted.current = true;
    setModeKeyState(key);
  };
  const ledgerModeKey = seedModeKeyFromLedger(active, modes);
  React.useEffect(() => {
    if (seedAttempted.current || modeKey !== null) return;
    if (ledgerModeKey === null) return;
    seedAttempted.current = true;
    setModeKeyState(ledgerModeKey);
  }, [ledgerModeKey, modeKey]);

  const effectiveMode = modeKey ?? modes[0]?.key ?? null;

  const provenanceNote = modeProvenanceNote(ledgerModeKey, effectiveMode, active?.confidence ?? null);

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
      `${v.mode} · sens ${v.sensitivity}${v.auto_color ? " · auto color" : v.hex ? ` · ${v.hex}` : " · auto off, device colour"}`,
  );

  const handleApply = () => {
    if (!effectiveMode) return;
    setApplying(true);
    applyMusic({
      ref: deviceRef,
      vars: buildMusicPayload(effectiveMode, sensitivity, autoColor, hex),
    })
      .catch(() => {
        /* error toast already surfaced by the mutation hook */
      })
      .finally(() => setApplying(false));
  };

  const summary = effectiveMode
    ? `${effectiveMode} · sens ${sensitivity}${autoColor ? " · auto color" : hex ? ` · ${hex}` : " · auto off, device colour"}`
    : "no mode selected";

  return (
    <StaggerList ariaLabel="Music controls">
      {/* modes */}
      <StaggerItem>
        <SectionLabel index="01" title="mode" />
        <div className="mt-3 flex flex-wrap gap-2">
          {modes.map((m) => {
            const isActive = m.key === effectiveMode;
            return (
              <button
                key={m.key}
                type="button"
                title={`mode ${m.value}`}
                aria-pressed={isActive}
                onClick={() => setModeKey(m.key)}
                className={cn(
                  "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] transition-colors duration-150",
                  isActive
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                )}
              >
                {m.key}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-low">
          {provenanceNote}
        </p>
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
          clears the other. Turning auto off with no color picked is still a
          real command (matches the CLI&apos;s <code>--no-auto-color</code>{" "}
          with no <code>--color</code>) — it is sent explicitly, not dropped.
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
