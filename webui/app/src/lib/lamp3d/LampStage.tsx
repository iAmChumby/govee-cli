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
import { motion } from "motion/react";

import { cn } from "@/lib/cn";
import type { DeviceState, DeviceSummary } from "@/lib/api";
import { useDeleteActiveMode } from "@/lib/queries";
import { UnknownModeChooser } from "@/components/stage/mode-picker";
import { brightnessGlow, type ResolvedLampState } from "./active-mode";
import { type PointerInputKind, shouldClaimGesture } from "./controls";
import { findScrollAncestor, useLampStage } from "./use-lamp-stage";
import {
  findInlineCarrier,
  intersectBox,
  maskClipPath,
  pickBackgroundIndex,
  stepFollow,
  type Box,
  type FollowStep,
} from "./stage-corner-mask";

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
        className="h-[var(--relative-stage-halo-height)] w-[var(--relative-stage-halo-width)] rounded-stage-halo transition-colors duration-motion-300"
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
      className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-low transition-colors duration-motion-150 hover:text-hi active:scale-95 disabled:opacity-40"
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
      className="pointer-events-none absolute bottom-2 right-2 rounded-chip border border-hairline bg-bg/80 px-1.5 py-0.5 font-mono text-nano leading-none tracking-micro text-low"
    >
      drag to rotate
    </div>
  );
}

export function LampStage({ state, variant = "full", className }: LampStageProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
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

  // The stage's rounded bottom corners cannot be clipped by the container's
  // `overflow-hidden`: the shared `WebGLRenderer` canvas is a `fixed` element
  // outside this subtree, and the rectangle each view is drawn into is a
  // square `gl.scissor` rect. The render therefore paints past the rounded
  // border at the bottom two corners, where the lit ground plane is opaque.
  //
  // A mask *inside* the stage cannot fix that: `overflow-hidden` clips its
  // outward `box-shadow` back to the rounded border (verified — only a
  // hairline survived), and at `lg` the sticky `<section>` ancestor creates
  // a stacking context that keeps any `z-20` child below the canvas. So the
  // same paint-only mask is mounted on `document.body` as a fixed overlay:
  // it inherits nothing, so the surface colour is copied from the stage.
  //
  // The overlay is a body-level painter exactly like the canvas is, so it
  // inherits the canvas's one hard rule: a view clips to its scrolling
  // ancestor, or it paints over the TopBar (CLAUDE.md, "The 3D stage"). The
  // mask is therefore clipped to the *same* rect the canvas scissors this
  // view to — `findScrollAncestor` is the function the canvas's own
  // registration uses, and `maskClipPath` intersects the mount point's box
  // with that ancestor's box exactly as `views.ts`'s `readBoxes` does. A
  // stage scrolled under the TopBar has its wedge stopped at the
  // scroller's edge, like the paint it is covering. It paints nothing but
  // those wedges and never touches the viewport, scissor rects, or camera.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const mask = document.createElement("div");
    mask.setAttribute("aria-hidden", "true");
    mask.className = "pointer-events-none fixed z-30 rounded-stage";
    document.body.appendChild(mask);

    // The surface the wedge has to match. The overlay lives at body level,
    // so it inherits none of the card's `--dev-*` tokens: the surface
    // colour is read from the DOM instead. It is the `.dev-bleed` panel
    // when the stage sits on a card, else the nearest opaque ancestor —
    // the app frame's own `bg-bg` on the device page, where the stage is
    // not on a card at all.
    const surfaceChain: HTMLElement[] = [];
    for (
      let el: HTMLElement | null =
        (stage.closest(".dev-bleed") as HTMLElement | null) ?? stage.parentElement;
      el;
      el = el.parentElement
    ) {
      surfaceChain.push(el);
    }
    const surfaceIndex = pickBackgroundIndex(
      surfaceChain.map((candidate) => window.getComputedStyle(candidate).backgroundColor),
    );
    const surfaceElement = surfaceIndex >= 0 ? surfaceChain[surfaceIndex] : null;

    let surfaceColor = "";
    const readSurface = (): string =>
      surfaceElement ? window.getComputedStyle(surfaceElement).backgroundColor : "";
    const applySurface = (step: FollowStep): void => {
      if (!step.changed) return;
      surfaceColor = step.colour;
      mask.style.boxShadow = `0 0 0 100px ${step.colour}`;
    };
    const paintSurface = (): void => {
      applySurface(stepFollow({ colour: surfaceColor, settled: 0 }, readSurface(), FOLLOW_SETTLED_READS));
    };

    // The card's surface is a MOVING target. `--dev-hue`/`--dev-alpha` are
    // written on the card's root and the panel's background transitions
    // over `--dur-slow`, so the mask has to follow the colour rather than
    // freeze the one it read at mount — otherwise every console plate is
    // painted in the untinted `--panel` colour while the card around it
    // carries the device's tint.
    //
    // The element that actually carries those properties is the card's
    // ROOT, an ancestor of the `.dev-bleed` panel, which only inherits
    // them: the panel's own attributes never change, so watching the panel
    // — as the first version of this mask did — never fired. The card
    // writes them in an effect that runs after this one, so the carrier is
    // resolved lazily and re-resolved on every tick until it appears.
    let carrier: Element | null = null;
    const carrierObserver = new MutationObserver(() => startFollowing());
    function resolveCarrier(): void {
      const found = findInlineCarrier(surfaceElement, "--dev-hue");
      if (found === carrier) return;
      carrierObserver.disconnect();
      carrier = found;
      if (carrier) {
        carrierObserver.observe(carrier, { attributes: true, attributeFilter: ["style"] });
      }
    }

    // While the surface is still moving, keep reading it: the card's
    // background transitions for `--dur-slow` after the last write, and a
    // mask frozen at the last write's colour would sit a visible step
    // behind the card it is imitating. The poll stops as soon as the
    // colour stops changing, so a settled card costs nothing.
    const FOLLOW_INTERVAL_MS = 40;
    const FOLLOW_SETTLED_READS = 3;
    let followTimer: number | null = null;
    let settledReads = 0;
    function followSurface(): void {
      resolveCarrier();
      const step = stepFollow(
        { colour: surfaceColor, settled: settledReads },
        readSurface(),
        FOLLOW_SETTLED_READS,
      );
      applySurface(step);
      settledReads = step.settled;
      if (!step.keepGoing) {
        followTimer = null;
        return;
      }
      followTimer = window.setTimeout(followSurface, FOLLOW_INTERVAL_MS);
    }
    function startFollowing(): void {
      resolveCarrier();
      paintSurface();
      if (followTimer !== null) window.clearTimeout(followTimer);
      settledReads = 0;
      followTimer = window.setTimeout(followSurface, FOLLOW_INTERVAL_MS);
    }

    const toBox = (r: DOMRect): Box => ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    });

    // The same scrolling ancestor the canvas scissors this view to.
    const scroller = findScrollAncestor(stage);
    const update = (): void => {
      const rect = stage.getBoundingClientRect();
      const maskBox = toBox(rect);
      // The canvas's scissor rect: the mount point's box intersected with
      // the scrolling ancestor's box (`views.ts`'s `readBoxes`). The mask
      // clips to the same rect, so the two always stop at the same edge.
      const mount = containerRef.current;
      const viewBox = toBox(mount ? mount.getBoundingClientRect() : rect);
      const scrollerRect = scroller?.getBoundingClientRect();
      const clipBox = scrollerRect
        ? intersectBox(viewBox, toBox(scrollerRect))
        : viewBox;
      const visible =
        maskBox.width > 0 &&
        maskBox.height > 0 &&
        clipBox !== null &&
        clipBox.width > 0 &&
        clipBox.height > 0;
      mask.style.display = visible ? "block" : "none";
      if (!visible) return;
      const cs = window.getComputedStyle(stage);
      mask.style.left = `${rect.left}px`;
      mask.style.top = `${rect.top}px`;
      mask.style.width = `${rect.width}px`;
      mask.style.height = `${rect.height}px`;
      mask.style.borderRadius = cs.borderRadius;
      mask.style.clipPath = maskClipPath(maskBox, clipBox);
      paintSurface();
    };

    update();
    startFollowing();
    // The stage can still be moving when the effect first runs (the page's
    // entrance transition), so settle it once afterwards as well.
    const settle = window.setTimeout(update, 500);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(stage);

    // Theme and per-device hue can change without a scroll/resize.
    const themeObserver = new MutationObserver(() => {
      update();
      startFollowing();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
      themeObserver.disconnect();
      carrierObserver.disconnect();
      if (followTimer !== null) window.clearTimeout(followTimer);
      mask.remove();
    };
  }, []);

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
      ref={stageRef}
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
            : "pointer-events-auto touch-pan-y focus-visible:focus-ring-painted focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-(--focus-ring)",
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
          {/* Wraps; deliberately NOT `truncate`. This caption is the honesty
              statement — its whole job is to carry the qualifiers ("assumed",
              "colour unknown", the age) that stop a render being read as
              fact. Clipping it with an ellipsis drops those qualifiers from
              the RIGHT, which is exactly where they live, and `title=` cannot
              rescue them because touch has no hover (CLAUDE.md). Measured at
              390px: "madisonnnn — DIY scene, assumed, colour unknown, 0s ago"
              overflowed and lost its tail, so the one caption whose text may
              never go missing was the one being cut. `max-w-[var(--relative-stage-caption-width)]` keeps it
              clear of the chooser control sharing this row, and `leading-snug`
              replaces `leading-none` so wrapped lines do not collide. */}
          {resolved.caption === "mode unknown — no ledger record" ? (
            // 1s pulse on first sight for the "unknown" state
            <motion.span
              initial={{ opacity: 0.5 }}
              animate={{ opacity: [0.5, 1, 0.5, 1] }}
              transition={{ duration: 1, ease: "easeInOut" }}
              className={cn(
                "relative z-20 min-w-0 max-w-[var(--relative-stage-caption-width)] rounded-chip border border-hairline bg-bg/95 px-1.5 py-0.5 font-mono leading-snug tracking-micro text-low pointer-coarse:whitespace-normal pointer-coarse:break-words",
                "text-data",
              )}
            >
              {resolved.caption}
            </motion.span>
          ) : (
            <span
              className={cn(
                "relative z-20 min-w-0 max-w-[var(--relative-stage-caption-width)] rounded-chip border border-hairline bg-bg/95 px-1.5 py-0.5 font-mono leading-snug tracking-micro text-low pointer-coarse:whitespace-normal pointer-coarse:break-words",
                "text-data",
              )}
            >
              {resolved.caption}
            </span>
          )}
          {control ? <span className="pointer-events-auto">{control}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
