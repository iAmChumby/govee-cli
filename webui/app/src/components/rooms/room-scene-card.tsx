"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, CheckCircle2, MinusCircle, RotateCcw, Trash2, XCircle } from "lucide-react";

import { Button, Chip, Panel } from "@/components/ui";
import {
  type CapturedDevice,
  type RoomSceneRestoreResult,
  type RoomSceneSummary,
} from "@/lib/api";
import { useDeleteRoom, useDevices, useRestoreRoom } from "@/lib/queries";
import { useDeviceBleed } from "@/lib/device-bleed";
import { rgbToHsl, kelvinToRgb, WARM_HSL, type Hsl } from "@/components/stage/color";
import { cn } from "@/lib/cn";

/* ==================================================================
   RoomSceneCard — WEBUI_V3_SPEC.md §10 T28. Tier: card surface is
   SIGNAL-SPILL (aggregate bleed, real captured data, never invented —
   see aggregateBleed below); restore/delete are CONTROL-RESPONSE via
   the shared Button's own press physics, nothing added here.
   ================================================================== */

/** One captured device's colour as plain RGB, or null when it contributes
 *  nothing knowable (off, or captured with neither colour nor temp). */
function effectiveRgb(device: CapturedDevice): [number, number, number] | null {
  if (device.color) return device.color;
  if (device.color_temp_k != null) {
    const [r, g, b] = kelvinToRgb(device.color_temp_k);
    return [r, g, b];
  }
  return null;
}

/**
 * "The palette this scene actually captured" — a plain RGB mean across the
 * devices that were on and had a known colour, per V3_VISUAL_DIRECTION.md
 * §C's own precedent (`dominant-hsl.ts`'s `paletteHsl` averages the same
 * way, for the same reason: two stops on opposite sides of the wheel should
 * settle to a neutral, not an arbitrary circular-mean side).
 *
 * Deliberately **not** a fabricated colour: a scene whose devices are all
 * off, or all `unknown`, resolves to `on: false`, which `useDeviceBleed`
 * renders as zero alpha — flat chassis, not a guessed hue. That is the
 * honesty rule applied one abstraction up: a card only shows colour when it
 * captured colour.
 */
function aggregateBleed(devices: CapturedDevice[]): {
  hsl: Hsl;
  on: boolean;
  brightness: number | null;
} {
  const lit = devices.filter((d) => d.power);
  const rgbs = lit.map(effectiveRgb).filter((rgb): rgb is [number, number, number] => rgb !== null);
  if (rgbs.length === 0) return { hsl: WARM_HSL, on: false, brightness: null };

  const sum = rgbs.reduce<[number, number, number]>(
    (acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b],
    [0, 0, 0],
  );
  const hsl = rgbToHsl([sum[0] / rgbs.length, sum[1] / rgbs.length, sum[2] / rgbs.length]);

  const brightnesses = lit.map((d) => d.brightness).filter((b): b is number => b != null);
  const brightness = brightnesses.length
    ? Math.round(brightnesses.reduce((a, b) => a + b, 0) / brightnesses.length)
    : null;

  return { hsl, on: true, brightness };
}

/** "3m ago" / "2h ago" / "5d ago" / a plain date past a month. */
function formatCapturedAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function RoomSceneCard({
  scene,
  detail,
}: {
  scene: RoomSceneSummary;
  /** the full per-device capture. `GET /rooms` carries this for every scene
   *  (room scenes are a local file, so sending it costs nothing upstream),
   *  which is what lets a card tint itself correctly on a cold page load and
   *  not just for a scene captured in this session. */
  detail?: CapturedDevice[];
}) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const devices = useDevices();
  const restoreRoom = useRestoreRoom();
  const deleteRoom = useDeleteRoom();
  const reduced = useReducedMotion();

  const [restoring, setRestoring] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [armDelete, setArmDelete] = React.useState(false);
  const [lastRestore, setLastRestore] = React.useState<RoomSceneRestoreResult | null>(null);

  const { hsl, on, brightness } = React.useMemo(() => aggregateBleed(detail ?? []), [detail]);
  useDeviceBleed(cardRef, hsl, on, brightness);

  React.useEffect(() => {
    if (!armDelete) return;
    const id = window.setTimeout(() => setArmDelete(false), 3000);
    return () => window.clearTimeout(id);
  }, [armDelete]);

  const nameOf = React.useCallback(
    (ref: string) => devices.data?.find((d) => d.ref === ref || d.id === ref)?.name ?? ref,
    [devices.data],
  );

  async function handleRestore() {
    setRestoring(true);
    try {
      setLastRestore(await restoreRoom(scene.name));
    } catch {
      // useRestoreRoom's own onError already toasted; nothing to add.
    } finally {
      setRestoring(false);
    }
  }

  async function handleDelete() {
    if (!armDelete) {
      setArmDelete(true);
      return;
    }
    setArmDelete(false);
    setDeleting(true);
    try {
      await deleteRoom(scene.name);
    } catch {
      // useDeleteRoom's own onError already toasted.
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div ref={cardRef} className="min-w-0">
      <Panel bleed className="relative flex h-full min-w-0 flex-col p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium leading-tight text-hi">{scene.name}</p>
            <p className="mt-0.5 font-mono text-[10px] text-low">{formatCapturedAt(scene.created_at)}</p>
          </div>
          <Chip className="shrink-0">
            {scene.device_count} {scene.device_count === 1 ? "device" : "devices"}
          </Chip>
        </div>

        {scene.unknown_count > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 font-mono text-[10px] leading-snug text-ember">
            <AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
            {scene.unknown_count} {scene.unknown_count === 1 ? "device was" : "devices were"} unknown
            at capture — skipped on restore, not guessed
          </p>
        ) : null}

        <div className="mt-auto flex items-center gap-2 pt-3">
          <Button
            variant="solid"
            size="sm"
            busy={restoring}
            onClick={() => void handleRestore()}
            className="flex-1"
          >
            <RotateCcw size={13} strokeWidth={1.75} aria-hidden />
            restore
          </Button>
          <Button
            size="sm"
            variant={armDelete ? "danger" : "ghost"}
            busy={deleting}
            aria-label={armDelete ? `Confirm delete ${scene.name}` : `Delete ${scene.name}`}
            title={armDelete ? undefined : "delete"}
            onBlur={() => setArmDelete(false)}
            onClick={() => void handleDelete()}
            className={cn("shrink-0 justify-center", armDelete ? "px-2.5" : "w-8 px-0")}
          >
            {armDelete ? "confirm?" : <Trash2 size={13} strokeWidth={1.5} aria-hidden />}
          </Button>
        </div>

        {/* restore results — per device, including skipped_reason. Surfaced
            here rather than left to the mutation's toast alone, which can
            only summarise a whole scene, not enumerate every device. */}
        {lastRestore ? (
          <motion.ul
            initial={reduced ? undefined : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="mt-3 space-y-1 overflow-hidden border-t border-hairline pt-2.5"
          >
            {lastRestore.results.map((step) => (
              <li key={step.ref} className="flex items-start gap-1.5 font-mono text-[10px] leading-snug">
                {/* A skip gets its own mark. The route reports it as ok:true —
                    correctly, since nothing failed — but a green tick beside
                    the word "skipped" tells the eye the device was restored
                    when it deliberately wasn't, which is the one thing this
                    whole feature is built not to do. */}
                {step.skipped_reason ? (
                  <MinusCircle size={11} strokeWidth={2} aria-hidden className="mt-px shrink-0 text-low" />
                ) : step.ok ? (
                  <CheckCircle2 size={11} strokeWidth={2} aria-hidden className="mt-px shrink-0 text-sage" />
                ) : (
                  <XCircle size={11} strokeWidth={2} aria-hidden className="mt-px shrink-0 text-ember" />
                )}
                {/* The name never truncates and the reason always may: on a
                    phone the reason is long enough to squeeze every name down
                    to one letter ("B… — skipped: mode was unknown when…"),
                    which loses the only part identifying which light it is. */}
                <span className="shrink-0 text-mid">{nameOf(step.ref)}</span>
                {/* §11.2(6): this is the entire reason room scenes exist —
                    a device that got skipped rather than guessed, and why.
                    `title` alone made that sentence hover-only, i.e. absent
                    on a phone. Under pointer:coarse the string wraps onto
                    its own line(s) instead of clipping; `title` stays for
                    desktop's cheaper hover path. */}
                {step.skipped_reason ? (
                  <span
                    className="min-w-0 truncate text-low pointer-coarse:whitespace-normal pointer-coarse:break-words"
                    title={step.skipped_reason}
                  >
                    — skipped: {step.skipped_reason}
                  </span>
                ) : step.error ? (
                  <span
                    className="min-w-0 truncate text-ember pointer-coarse:whitespace-normal pointer-coarse:break-words"
                    title={step.error}
                  >
                    — {step.error}
                  </span>
                ) : null}
              </li>
            ))}
          </motion.ul>
        ) : null}
      </Panel>
    </div>
  );
}
