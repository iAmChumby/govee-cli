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
import { type PointerInputKind, shouldClaimGesture } from "./controls";
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

/** Persists across sessions ("fade out permanently") rather than per-mount
 *  React state, which would forget the moment the device page is left and
 *  reopened. `localStorage` can throw in private-browsing/quota-exceeded
 *  states in some browsers; every access below is wrapped so a storage
 *  failure degrades to "the hint shows again next time", a cosmetic
 *  nuisance, never a thrown error that would take the whole stage down. */
const ROTATE_HINT_DISMISSED_KEY = "lamp3d.rotate-hint-dismissed";

function readRotateHintDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ROTATE_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRotateHintDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROTATE_HINT_DISMISSED_KEY, "1");
  } catch {
    // Best-effort only — see the block comment above.
  }
}

/**
 * Detects the hero's first successful rotate gesture so the drag
 * affordance can disappear once it has done its job — a hint that never
 * goes away is worse than no hint at all.
 *
 * This runs a second, independent set of pointer listeners on the exact
 * element `attachOrbitControls` (`renderer.ts` → `controls.ts`) already
 * listens on, rather than getting a callback from that module directly:
 * `AttachOrbitControlsOptions` is a fixed object `renderer.ts` alone
 * constructs, and `renderer.ts` is out of scope for this change, so there
 * is no call site able to hand this component a "gesture claimed" callback.
 * Reusing `shouldClaimGesture` (the exact predicate `controls.ts` itself
 * uses to decide the same question) keeps this listener asking "did a real
 * rotate happen" the identical way the orbit control does, rather than
 * inventing a second, looser threshold that could disagree with it. This
 * listener never calls `preventDefault()` or `setPointerCapture()`, so it
 * only observes — it cannot compete with or interfere with the orbit
 * control's own listeners on the same node.
 */
function useDismissRotateHintOnFirstDrag(
  containerRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  onDismiss: () => void,
): void {
  React.useEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (!el) return;

    let down = false;
    let startX = 0;
    let startY = 0;
    let pointerType: PointerInputKind = "mouse";

    function onPointerDown(e: PointerEvent): void {
      down = true;
      startX = e.clientX;
      startY = e.clientY;
      pointerType = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
    }

    function onPointerMove(e: PointerEvent): void {
      if (!down) return;
      if (!shouldClaimGesture(e.clientX - startX, e.clientY - startY, pointerType)) return;
      down = false;
      onDismiss();
    }

    function onPointerUp(): void {
      down = false;
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [containerRef, active, onDismiss]);
}

/**
 * The quiet corner hint advertising that the hero rotates — same register
 * as the honesty caption chip (small, mono, low-contrast, corner-anchored),
 * anchored to the opposite corner so the two never collide. `aria-hidden`
 * and `pointer-events-none` for the same reason: this is advice about a
 * gesture, not a control surface, and must never itself intercept the drag
 * it is describing.
 */
function RotateHint() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-2 right-2 rounded-chip border border-hairline bg-bg/80 px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-micro text-low"
    >
      drag to rotate
    </div>
  );
}

export function LampStage({ state, variant = "full", className }: LampStageProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const { resolved, webglAvailable } = useLampStage({ containerRef, state, variant });
  const mini = variant === "mini";
  const name = state.name ?? state.ref;

  // Starts `true` (hint hidden) on both server and client for the same
  // hydration reason `useLampStage`'s own `webglAvailable` starts `true`:
  // `localStorage` is unavailable during SSR, so evaluating the real value
  // during render would make the server's markup and the client's first
  // hydration pass disagree. The effect below corrects it to the real,
  // persisted value one tick after mount; a browser that has never
  // dismissed the hint sees it appear a frame late rather than never
  // matching hydration at all.
  const [hintDismissed, setHintDismissed] = React.useState(true);
  React.useEffect(() => {
    if (!mini) setHintDismissed(readRotateHintDismissed());
  }, [mini]);
  const dismissHint = React.useCallback(() => {
    writeRotateHintDismissed();
    setHintDismissed(true);
  }, []);
  useDismissRotateHintOnFirstDrag(containerRef, !mini && !hintDismissed, dismissHint);

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
          single fixed element behind every mounted stage (decision 1). This
          div exists only to be measured: its `getBoundingClientRect()`
          becomes the scissor rect that canvas draws this device's model
          into. It must stay exactly this box — no padding, no inset —
          because that box is also what `scripts/viewport_audit.py` gates as
          unmoved. Changing `pointer-events`/`role`/`tabIndex` below changes
          what events and assistive tech this box accepts, never its
          geometry.

          Root cause of "cannot be rotated on any device": this div carried
          `pointer-events-none` unconditionally, so the `pointerdown`/
          `pointermove`/`pointerup` listeners `attachOrbitControls`
          (`renderer.ts` → `controls.ts`) registers on it were never once
          invoked by the browser — on desktop or mobile. Only the hero
          (`variant === "full"`) gets `pointer-events-auto` here: a mini
          plate is nested inside a `<Link>` on the dashboard, and a drag
          there would fight navigation (the design doc's own non-goal).
          `cn()` does not merge conflicting Tailwind classes (no
          `tailwind-merge`), so the two variants emit one whole
          `pointer-events-*` value each rather than trying to have
          `pointer-events-auto` win over `pointer-events-none` on the same
          element.

          `role="img"` + `tabIndex` + `aria-label` (hero only) is a
          deliberate, imperfect fit rather than an oversight: no ARIA role
          precisely models "a draggable 3D viewport". `role="application"`
          would suppress the screen reader's own navigation entirely, which
          is worse for a control with no discrete value to report; `role=
          "slider"` implies exactly one bounded value with `aria-valuenow`,
          and orbit has two (an azimuth that wraps and a clamped elevation).
          `role="img"` with a label describing both what is shown and how to
          drive it is the same trade-off major 3D-viewer accessibility
          implementations settle on. Arrow-key rotation is wired inside
          `attachOrbitControls` itself (`controls.ts`'s own `keydown`
          listener) — reachable from this file's own owned files without
          touching `renderer.ts`. */}
      <div
        ref={containerRef}
        {...(mini
          ? { "aria-hidden": true as const }
          : {
              role: "img" as const,
              "aria-label": `${name} — 3D view. Drag, or focus and use arrow keys, to rotate.`,
              tabIndex: 0,
            })}
        className={cn(
          "absolute inset-0",
          mini
            ? "pointer-events-none"
            : "pointer-events-auto touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      />

      {!mini && !hintDismissed ? <RotateHint /> : null}

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
