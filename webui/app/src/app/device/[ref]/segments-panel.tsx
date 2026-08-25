"use client";

import * as React from "react";

import { api, type DeviceState } from "@/lib/api";
import { useApplyMutation } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Slider } from "@/components/ui/slider";
import { DeviceStage } from "@/components/stage/stage";
import { HexField, SwatchRow, normalizeHex } from "./color-picker";

/* ==================================================================
    Segments panel — paint mode. Select cloud segments on the stage's
    address rail (the matrix lamp itself is display-only — cloud v2
    only exposes the coarse 0-14 segment space), pick a paint color
    (defaults to the device's current color), then apply through the
    sidecar's segments endpoint.
    ================================================================== */

interface SegmentsPanelProps {
  refId: string;
  state: DeviceState;
}

export function SegmentsPanel({ refId, state }: SegmentsPanelProps) {
  const caps = state.capabilities;
  const [selected, setSelected] = React.useState<number[]>([]);
  const [paintHex, setPaintHex] = React.useState<string | null>(null);
  const [segBrightness, setSegBrightness] = React.useState<number>(state.brightness ?? 60);
  const [applying, setApplying] = React.useState(false);

  const applySegments = useApplyMutation<{ segments: number[]; hex?: string; brightness?: number }>(
    "segments",
    ({ ref, vars }) => api.setSegments(ref, vars),
    (vars) =>
      `${vars.segments.length} segment${vars.segments.length === 1 ? "" : "s"}` +
      (vars.hex ? ` · ${vars.hex.toUpperCase()}` : "") +
      (vars.brightness !== undefined ? ` · ${vars.brightness}%` : ""),
  );

  const handleApply = async () => {
    if (selected.length === 0 || applying) return;
    setApplying(true);
    try {
      await applySegments({
        ref: refId,
        vars: {
          segments: selected,
          hex: paintHex ?? undefined,
          brightness: caps?.segment_brightness ? segBrightness : undefined,
        },
      });
      setSelected([]);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-5 pt-5">
      {/* interactive stage — matrix display + segment address rail */}
      <DeviceStage
        state={state}
        interactive
        selected={selected}
        onSelectionChange={setSelected}
        className="h-[340px]"
      />

      {/* palette */}
      <div>
        <SectionLabel index="01" title="paint" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SwatchRow
            activeHex={paintHex ?? state.color?.hex ?? null}
            onPick={(hex) => setPaintHex(normalizeHex(hex))}
            ariaGroupLabel="Paint colors"
          />
          <HexField onCommit={(hex) => setPaintHex(hex)} />
        </div>
        {paintHex === null ? (
          <p className="mt-2 font-mono text-[10px] text-low">
            no paint picked — applies the current device color
          </p>
        ) : null}
      </div>

      {/* per-segment brightness — only where the model supports it */}
      <div>
        <SectionLabel index="02" title="segment brightness" />
        {caps?.segment_brightness ? (
          <div className="mt-3 flex items-center gap-4">
            <Slider
              value={segBrightness}
              min={0}
              max={100}
              step={1}
              onValueCommit={setSegBrightness}
              ariaLabel="Segment brightness"
              showBubble
              className="flex-1"
            />
            <span className="w-[4ch] text-right font-mono text-[11px] text-mid">
              {segBrightness}%
            </span>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-low">
            not supported on this model
          </p>
        )}
      </div>

      {/* selection + apply */}
      <div className="flex items-center gap-3 border-t border-hairline pt-4">
        <span
          aria-live="polite"
          className="font-mono text-[11px] text-mid"
        >
          {selected.length === 0
            ? "no segments selected"
            : `${selected.length} selected · ${formatRange(selected)}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={selected.length === 0}
          onClick={() => setSelected([])}
        >
          clear
        </Button>
        <Button
          variant="solid"
          size="sm"
          className="ml-auto"
          busy={applying}
          disabled={selected.length === 0}
          onClick={() => void handleApply()}
        >
          apply
        </Button>
      </div>
    </div>
  );
}

/** "0,3,5" for sparse sets, "2-6" style runs collapsed where contiguous. */
function formatRange(indices: number[]): string {
  if (indices.length === 0) return "";
  const parts: string[] = [];
  let start = indices[0];
  let prev = indices[0];
  for (const i of indices.slice(1)) {
    if (i === prev + 1) {
      prev = i;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = i;
    prev = i;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(",");
}
