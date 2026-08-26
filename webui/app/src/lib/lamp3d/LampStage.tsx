"use client";

/**
 * LampStage — the React shell around `renderer.ts`'s shared WebGL view
 * (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`). Replaces
 * `DeviceStage` at both call sites (device page hero, dashboard plates) —
 * wiring that swap is a later task's job, not this one's.
 *
 * The prop set is deliberately narrower than `DeviceStageProps`: no
 * `interactive` / `selected` / `onSelectionChange` / `onPaintSegments` /
 * `matrixCells`. The design doc's Non-goals section verified those props
 * have no call site today — the 3D stage ships display-only, and 3D
 * raycast picking is a later addition if the paint studio ever wants this
 * stage as an input surface.
 *
 * The outer box is byte-for-byte `DeviceStage`'s own: same `role="group"`,
 * the same base classes. `scripts/viewport_audit.py` gates that box as one
 * that must not move; this component earns that gate the same way
 * `DeviceStage` did, by never touching those classes.
 */

import * as React from "react";
import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/cn";
import type { DeviceState, DeviceSummary } from "@/lib/api";
import { useDeleteActiveMode } from "@/lib/queries";
import { UnknownModeChooser } from "@/components/stage/mode-picker";
import { brightnessGlow, type ResolvedLampState } from "./active-mode";
import { useLampStage } from "./use-lamp-stage";

export interface LampStageProps {
  state: DeviceState | DeviceSummary;
  /** full = device console centerpiece (hero); mini = dashboard plate. */
  variant?: "full" | "mini";
  className?: string;
}

/** The no-WebGL silhouette's off/unknown tone. Not `stage.tsx`'s own
 *  `NEUTRAL_CHASSIS_HSL` constant (that file is HSL-tuple typed and this
 *  fallback only ever needs one CSS colour value) — the same [0,0,22]-ish
 *  near-black neutral, expressed directly as the one hex string this tiny
 *  component uses. */
const NEUTRAL_SILHOUETTE_HEX = "#38383c";

/** Rule 1 ("unknown means unknown") applied to the fallback path too: a
 *  device whose `spec` resolved to `null` — no ledger record, or a mode the
 *  ledger has no record for — gets the same neutral tone the GL path's
 *  zeroed LEDs would read as, never a fabricated colour. Powered-off reads
 *  neutral for the same reason `applyEmission` zeroes the LED buffer on
 *  `!power`: an unlit object, not a device that merely stopped reporting. */
function silhouetteColor(resolved: ResolvedLampState): string {
  if (!resolved.power || !resolved.spec) return NEUTRAL_SILHOUETTE_HEX;
  return resolved.spec.palette.colors[0] ?? NEUTRAL_SILHOUETTE_HEX;
}

/**
 * The `isWebGLAvailable() === false` fallback: one small, deliberate tinted
 * capsule — not the resurrected per-model CSS instrument set `stage.tsx`
 * used to carry. `brightnessGlow` is the same curve the GL emission layer
 * uses, so dimming reads the same way here as it would have on a working
 * GL path.
 */
function StaticSilhouette({ resolved }: { resolved: ResolvedLampState }) {
  const color = silhouetteColor(resolved);
  const opacity = resolved.power ? brightnessGlow(resolved.brightness) : 0.18;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className="h-[56%] w-[32%] rounded-[46%_46%_18%_18%/58%_58%_14%_14%] transition-colors duration-300"
        style={{ backgroundColor: color, opacity }}
      />
    </div>
  );
}

/**
 * The "that is not what I see" reset (WEBUI_V3_SPEC.md §3.6/§4.3), ported
 * verbatim from `stage.tsx`'s `ActiveModeReset` — same markup, same
 * classes, same `DELETE /devices/{ref}/active-mode` call via
 * `useDeleteActiveMode` — per the design doc's migration note: port this
 * before `stage.tsx` is deleted, not during it, so it never has a gap where
 * neither copy exists.
 */
function ActiveModeReset({ deviceRef }: { deviceRef: string }) {
  const deleteActiveMode = useDeleteActiveMode();
  const [busy, setBusy] = React.useState(false);

  const handleReset = React.useCallback(() => {
    setBusy(true);
    void deleteActiveMode(deviceRef).finally(() => setBusy(false));
  }, [deleteActiveMode, deviceRef]);

  return (
    <button
      type="button"
      aria-label="Not what I see — reset active mode"
      title="Not what I see — reset"
      onClick={handleReset}
      disabled={busy}
      className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-low outline-none transition-colors duration-150 hover:text-hi active:scale-95 disabled:opacity-40"
    >
      <RotateCcw aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}

export function LampStage({ state, variant = "full", className }: LampStageProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const { resolved, webglAvailable } = useLampStage({ containerRef, state, variant });
  const mini = variant === "mini";
  const name = state.name ?? state.ref;

  // Both controls are full-stage only: a plate is nested inside a `<Link>`
  // on the dashboard, and a second interactive element in there is both
  // invalid HTML and hijacks the card's navigation click. `showResetControl`
  // and `showUnknownChooser` are already mutually exclusive at the source
  // (`resolveLampState`), so at most one of these is ever non-null.
  const control = mini
    ? null
    : resolved.showResetControl
      ? <ActiveModeReset deviceRef={state.ref} />
      : resolved.showUnknownChooser
        ? <UnknownModeChooser deviceRef={state.ref} />
        : null;

  return (
    <div
      role="group"
      aria-label={`${name} live stage`}
      className={cn(
        "relative select-none overflow-hidden rounded-stage border border-hairline bg-raised",
        className,
      )}
    >
      {/* The shared renderer.ts canvas lives elsewhere in the DOM — a
          single fixed, aria-hidden element behind every mounted stage
          (decision 1). This div exists only to be measured: its
          `getBoundingClientRect()` becomes the scissor rect that canvas
          draws this device's model into. It must stay exactly this box —
          no padding, no inset — because that box is also what
          `scripts/viewport_audit.py` gates as unmoved. */}
      <div ref={containerRef} aria-hidden className="pointer-events-none absolute inset-0" />

      {!webglAvailable ? <StaticSilhouette resolved={resolved} /> : null}

      {/* The honesty caption + reset/chooser (WEBUI_V3_SPEC.md §3.6/§4.3),
          ported unchanged from `stage.tsx`: never rendered when there is
          nothing honest to say (no ledger record read at all), always
          rendered with the confidence/age spelled out verbatim otherwise —
          see `active-mode.ts`'s `resolveLampState` for the exact gating. */}
      {resolved.caption ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <span
            className={cn(
              "truncate rounded-chip border border-hairline bg-bg/80 px-1.5 py-0.5 font-mono leading-none tracking-micro text-low",
              mini ? "text-[7px]" : "text-[9px]",
            )}
          >
            {resolved.caption}
          </span>
          {control ? <span className="pointer-events-auto">{control}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
