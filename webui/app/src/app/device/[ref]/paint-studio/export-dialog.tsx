"use client";

/**
 * Turns the painted canvas + motion descriptor into a real, playable
 * `scenes/*.json` keyframe effect (§5.6) — the part of the studio that
 * actually beats the Govee app: every animation becomes an inspectable,
 * git-trackable, CLI-playable file instead of an opaque numeric-ID cloud
 * scene (§5.9).
 *
 * Transport choice is offered only when the model can actually play both
 * ways (`prefer_ble_effects` + a nonzero BLE segment count — H6056); the
 * H6022 is forced to cloud (its BLE protocol is unimplemented). Whichever
 * transport is chosen is sent as `force` on the create request too, so the
 * segment ids this dialog computed and the bounds the backend validates
 * against are guaranteed to agree — never left to the backend's own
 * BLE-preference default, which could silently pick the other transport.
 *
 * "Save as effect" performs zero device I/O — only `POST /effects`.
 * "Save & play" additionally starts playback afterward, an explicit,
 * separate action the same way `EffectsPanel`'s play button is.
 *
 * Note: `EffectCreateRequest` (T10/T09) has no `description` field — the
 * backend never persists one (`effects.py`'s `create_effect` writes only
 * `{name, segments, loop, fps}`) — so this dialog doesn't offer a
 * description field that would silently do nothing.
 */

import * as React from "react";

import type { Capabilities, EffectCreateRequest, SegmentCalibration } from "@/lib/api";
import { api } from "@/lib/api";
import { useApplyMutation, useCreateEffect } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  applySegmentPermutation,
  buildEffectSegments,
  downsampleFrame,
  frameCountFor,
  renderFrames,
  segmentBoundaries,
  totalLeds,
  type Geometry,
  type Motion,
} from "./device-geometry";

// The backend's own authoritative fps ceilings
// (`govee_cli/commands/effect.py`: `CLOUD_DEFAULT_FPS=1.0`,
// `CLOUD_MAX_FPS=2.0`) aren't exposed over the API — POST /effects caps
// cloud playback to these regardless of what's sent, so a slightly-off
// frontend default here is always self-correcting server-side. BLE has no
// documented cap (§5.6: "up to full BLE rate"); 10fps is this dialog's own
// authoring default, not a hardware fact.
export const CLOUD_DEFAULT_FPS = 1;
export const CLOUD_MAX_FPS = 2;
export const BLE_DEFAULT_FPS = 10;

export interface ExportDialogProps {
  refId: string;
  geometry: Geometry;
  canvas: Uint8ClampedArray;
  motion: Motion;
  capabilities: Capabilities | undefined;
  calibration: SegmentCalibration | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Transport = "cloud" | "ble";

export function ExportDialog({
  refId,
  geometry,
  canvas,
  motion,
  capabilities,
  calibration,
  open,
  onOpenChange,
}: ExportDialogProps) {
  const canBle = (capabilities?.prefer_ble_effects ?? false) && (capabilities?.segment_count_ble ?? 0) > 0;
  const [name, setName] = React.useState("");
  const [loop, setLoop] = React.useState(true);
  const [transport, setTransport] = React.useState<Transport>(canBle ? "ble" : "cloud");
  const [fps, setFps] = React.useState(canBle ? BLE_DEFAULT_FPS : CLOUD_DEFAULT_FPS);
  const [playAfter, setPlayAfter] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTransport(canBle ? "ble" : "cloud");
      setFps(canBle ? BLE_DEFAULT_FPS : CLOUD_DEFAULT_FPS);
    }
  }, [open, canBle]);

  const createEffect = useCreateEffect();
  const playEffect = useApplyMutation<{ file: string; force: Transport }>(
    "effect",
    ({ ref, vars }) => api.playEffect(ref, vars.file, vars.force),
  );
  const [saving, setSaving] = React.useState(false);

  const segmentCount =
    transport === "cloud" ? capabilities?.segment_count_cloud ?? 15 : capabilities?.segment_count_ble ?? 0;

  const frameCount = frameCountFor(motion, fps);

  const handleSave = async () => {
    if (!name.trim() || segmentCount <= 0 || saving) return;
    setSaving(true);
    try {
      const boundaries = segmentBoundaries(totalLeds(geometry), segmentCount, calibration ?? null);
      const frames = renderFrames(canvas, geometry, motion, fps);
      const bySegment = frames.map((frame) =>
        applySegmentPermutation(
          downsampleFrame(frame, boundaries),
          calibration?.calibrated ? calibration.permutation : null,
        ),
      );
      const emitted = buildEffectSegments(bySegment, 1000 / fps);
      const body: EffectCreateRequest = {
        device: refId,
        name: name.trim(),
        segments: emitted,
        loop,
        fps,
        force: transport,
      };
      const saved = await createEffect(body);
      if (playAfter) {
        await playEffect({ ref: refId, vars: { file: saved.file, force: transport } });
      }
      onOpenChange(false);
      setName("");
    } catch {
      // error toasts already surfaced by the mutation hooks
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogTitle>Save as effect</DialogTitle>
        <DialogDescription>
          Writes a real keyframe file to <code>scenes/</code> — zero device I/O until you
          choose to play it.
        </DialogDescription>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="effect-name" className="mb-1.5 block font-mono text-[10px] uppercase tracking-micro text-low">
              name
            </label>
            <input
              id="effect-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="shelf-drum-spiral"
              autoComplete="off"
              className="h-9 w-full rounded-btn border border-hairline bg-raised px-3 text-[13px] text-hi outline-none transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong"
            />
          </div>

          {canBle ? (
            <div>
              <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-micro text-low">
                transport
              </span>
              <div role="group" aria-label="Export transport" className="flex items-center gap-1">
                {(["ble", "cloud"] as Transport[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={transport === t}
                    onClick={() => {
                      setTransport(t);
                      setFps(t === "ble" ? BLE_DEFAULT_FPS : CLOUD_DEFAULT_FPS);
                    }}
                    className={
                      transport === t
                        ? "h-8 cursor-pointer rounded-btn border border-hairline-strong bg-accent-dim px-3 font-mono text-[10px] uppercase tracking-[0.06em] text-hi"
                        : "h-8 cursor-pointer rounded-btn border border-hairline px-3 font-mono text-[10px] uppercase tracking-[0.06em] text-mid hover:border-hairline-strong hover:text-hi"
                    }
                  >
                    {t === "ble" ? "ble · full rate" : "cloud · 2fps cap"}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="font-mono text-[10px] text-low">
              cloud v2 only — {segmentCount} segments, capped near {CLOUD_MAX_FPS}fps.
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-micro text-low">loop playback</span>
            <Switch checked={loop} onCheckedChange={setLoop} ariaLabel="Loop playback" />
          </div>

          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-micro text-low">play after saving</span>
            <Switch checked={playAfter} onCheckedChange={setPlayAfter} ariaLabel="Play after saving" />
          </div>

          <p className="border-t border-hairline pt-3 font-mono text-[10px] leading-relaxed text-low">
            {frameCount} frame{frameCount === 1 ? "" : "s"} → {segmentCount} segments at {fps}fps.
          </p>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              cancel
            </Button>
            <Button
              variant="solid"
              size="sm"
              className="ml-auto"
              busy={saving}
              disabled={!name.trim() || segmentCount <= 0}
              onClick={() => void handleSave()}
            >
              {playAfter ? "save & play" : "save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
