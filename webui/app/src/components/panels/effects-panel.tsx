"use client";

/**
 * EffectsPanel — keyframe effect library + playback state
 * (WEBUI_SPEC §4 /effects, /effects/play, /effects/playing).
 *
 * The sidecar keeps one playback per device; "playing" is derived by
 * matching the polled playing list against this deviceRef. Play/stop must
 * invalidate the ["effects-playing"] key themselves — useApplyMutation only
 * invalidates device-derived keys.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";

import { api, type EffectInfo } from "@/lib/api";
import {
  useApplyMutation,
  useDeviceState,
  useEffects,
  usePlayingEffects,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import {
  CountChip,
  EmptyState,
  PanelFrame,
  QueryErrorLine,
  RowSkeleton,
  StaggerItem,
  StaggerList,
  queryErrorMessage,
} from "./shared";

export function EffectsPanel({ deviceRef }: { deviceRef: string }) {
  const effects = useEffects();
  const playingQ = usePlayingEffects();
  const deviceQ = useDeviceState(deviceRef);
  const queryClient = useQueryClient();

  const [pendingFile, setPendingFile] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState(false);

  // One playback per device exists server-side — match on ref.
  const mine = playingQ.data?.find((p) => p.device === deviceRef) ?? null;
  // BLE-preferred models run keyframes at full frame rate over GATT;
  // cloud playback is capped near 2fps by the request budget.
  const preferBle = deviceQ.data?.capabilities?.prefer_ble_effects;

  const playEffect = useApplyMutation<{ file: string }>(
    "effect",
    ({ ref, vars }) => api.playEffect(ref, vars.file),
    (v) => v.file,
  );

  const stopEffect = useApplyMutation<void>(
    "stop effect",
    ({ ref }) => api.stopEffect(ref),
  );

  const handlePlay = (file: string) => {
    setPendingFile(file);
    playEffect({ ref: deviceRef, vars: { file } })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["effects-playing"] }),
      )
      .catch(() => {
        /* error toast already surfaced by the mutation hook */
      })
      .finally(() => setPendingFile((cur) => (cur === file ? null : cur)));
  };

  const handleStop = () => {
    setStopping(true);
    stopEffect({ ref: deviceRef, vars: undefined })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["effects-playing"] }),
      )
      .catch(() => {
        /* error toast already surfaced by the mutation hook */
      })
      .finally(() => setStopping(false));
  };

  const all = effects.data ?? [];

  return (
    <PanelFrame
      label="effects"
      chips={
        <>
          {effects.data && !effects.isError ? (
            <CountChip count={all.length} singular="effect" />
          ) : null}
          {mine ? <Chip tone="ok">playing</Chip> : null}
        </>
      }
    >
      {/* now playing banner */}
      {mine ? (
        <div className="mb-3 flex items-center gap-2.5 rounded-card border border-hairline-strong bg-accent-dim px-3 py-2.5">
          <StatusDot tone="ok" />
          <span className="min-w-0 truncate font-mono text-[11px] text-hi">
            {mine.file}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-low">
            {mine.transport} · {mine.fps} fps
          </span>
          <StopButton busy={stopping} onStop={handleStop} label="Stop effect playback" />
        </div>
      ) : null}

      {effects.isError ? (
        <QueryErrorLine
          message={queryErrorMessage(effects.error)}
          onRetry={() => void effects.refetch()}
        />
      ) : null}

      {effects.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : null}

      {!effects.isLoading && !effects.isError && all.length === 0 ? (
        <EmptyState
          title="no effect files found"
          hint="drop keyframe JSON files into the repo scenes/ directory — they appear here after reload."
        />
      ) : null}

      {effects.data && !effects.isError && all.length > 0 ? (
        <StaggerList ariaLabel="Effects" className="space-y-2">
          {all.map((e) => {
            const isThisPlaying = mine?.file === e.file;
            return (
              <StaggerItem key={e.file}>
                <EffectRow
                  effect={e}
                  playing={isThisPlaying}
                  pending={pendingFile === e.file}
                  stopping={stopping && isThisPlaying}
                  onPlay={handlePlay}
                  onStop={handleStop}
                />
              </StaggerItem>
            );
          })}
        </StaggerList>
      ) : null}

      {/* transport note */}
      <p className="mt-3 border-t border-hairline pt-3 font-mono text-[10px] leading-relaxed text-low">
        {preferBle === false
          ? "cloud playback — the request budget caps animation near 2 fps."
          : "ble-preferred model — keyframes animate at full frame rate over gatt."}
        {" "}one playback per device; starting another stops the current one.
      </p>
    </PanelFrame>
  );
}

/* ------------------------------------------------------------ effect row */

interface EffectRowProps {
  effect: EffectInfo;
  playing: boolean;
  pending: boolean;
  stopping: boolean;
  onPlay: (file: string) => void;
  onStop: () => void;
}

function EffectRow({
  effect,
  playing,
  pending,
  stopping,
  onPlay,
  onStop,
}: EffectRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-card border bg-raised px-3 py-2.5 transition-colors duration-150",
        playing ? "border-hairline-strong ring-1 ring-accent" : "border-hairline",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] leading-tight text-hi">{effect.name}</p>
        <p className="mt-0.5 truncate font-mono text-[10px] leading-none text-low">
          {effect.fps} fps · {effect.loop ? "loop" : "once"} ·{" "}
          {effect.segments} seg{effect.segments === 1 ? "" : "s"}
          {formatSegmentIds(effect.segment_ids)}
        </p>
      </div>

      {playing ? (
        <StopButton busy={stopping} onStop={onStop} label={`Stop ${effect.name}`} />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          busy={pending}
          onClick={() => onPlay(effect.file)}
          aria-label={`Play effect ${effect.name}`}
        >
          <Play size={11} strokeWidth={1.75} aria-hidden />
          play
        </Button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- stop button */

interface StopButtonProps {
  busy: boolean;
  onStop: () => void;
  label: string;
}

/**
 * Danger ghost — ember outline and text on the panel surface. Built as a
 * raw button so the ember hover states never fight the shared Button
 * variant classes in stylesheet order.
 */
function StopButton({ busy, onStop, label }: StopButtonProps) {
  return (
    <button
      type="button"
      onClick={onStop}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={label}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-btn border border-ember/40 px-2.5 text-[10px] font-medium uppercase leading-none tracking-[0.08em] text-ember transition-colors duration-150 hover:border-ember hover:bg-ember/10 disabled:pointer-events-none disabled:opacity-40"
    >
      {busy ? <Spinner /> : <Square size={10} strokeWidth={2} aria-hidden />}
      stop
    </button>
  );
}

/* ------------------------------------------------------------------ meta */

/** " · seg 0-5" for runs, " · seg 0,3,7" for sparse sets, "" when full-range. */
function formatSegmentIds(ids: number[]): string {
  if (ids.length === 0) return "";
  if (ids.length > 5) return ` · seg ${ids[0]}-${ids[ids.length - 1]}`;
  return ` · seg ${ids.join(",")}`;
}
