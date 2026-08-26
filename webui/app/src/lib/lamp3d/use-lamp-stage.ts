"use client";

/**
 * React hook wiring one device's DOM box into the shared `renderer.ts` view
 * registry (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`),
 * mirroring `motion-engine/use-motion-stage.ts`'s own discipline: no
 * per-frame React state anywhere, every mutable value a draw path needs
 * lives in a ref updated on render, and the mount/unmount effect's
 * dependency array stays as small as the values that must actually trigger
 * a remount — everything else is read through a ref at the moment it's
 * needed instead of forcing `mountLampView`/`dispose` to run again.
 *
 * `renderer.ts` already IS decision 4's single `driver.ts` subscriber
 * (registered once, lazily, on the very first `mountLampView` call) — this
 * hook never calls `subscribe()` itself. Its whole job is translating React
 * lifecycle (mount / prop update / unmount) and a `DeviceState`/
 * `DeviceSummary` prop into the `LampViewHandle` calls the shared ticker
 * already knows how to draw from.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";

import type { DeviceState, DeviceSummary } from "@/lib/api";
import { layoutFromCapabilities, layoutKey } from "./models/types";
import { isWebGLAvailable, mountLampView, type LampViewHandle } from "./renderer";
import { resolveLampState, type ResolvedLampState } from "./active-mode";

/**
 * Walks up from `el` to find the nearest scrolling ancestor. There is no
 * single shared shell element to hardcode here — every route owns its own
 * `<main className="... overflow-y-auto">` (`app/page.tsx`,
 * `app/device/[ref]/page.tsx`, `app/rooms/page.tsx`, ...), so the clipping
 * ancestor has to be discovered per-mount instead. Read as
 * `ViewRegistration.clipTo` (`views.ts`): a plate scrolled up under the
 * fixed `TopBar` must stop scissoring at this element's edge rather than
 * paint through it (decision 2).
 */
function findScrollAncestor(el: HTMLElement): HTMLElement | undefined {
  if (typeof window === "undefined") return undefined;
  let node = el.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return undefined;
}

export interface UseLampStageParams {
  /** The stage's own outer box — the `role="group"` wrapper `LampStage.tsx`
   *  renders, with this hook's mount point as a child filling it. Its
   *  `getBoundingClientRect()` becomes the scissor rect `renderer.ts` draws
   *  into, and is the exact box `scripts/viewport_audit.py` gates as "must
   *  not move" — so the mount point, not some inner padded box, is what
   *  gets registered. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  state: DeviceState | DeviceSummary;
  variant: "full" | "mini";
}

export interface UseLampStageResult {
  /** The honesty layer's resolved read — caption/chooser/reset gating and
   *  the LED field input both come from this one call, so `LampStage.tsx`'s
   *  DOM layer and the GL layer can never disagree about what the device is
   *  doing. */
  resolved: ResolvedLampState;
  /** `false` means `LampStage.tsx` must render the static CSS silhouette
   *  instead of the mount point's GL content — this hook never calls
   *  `mountLampView` while `isWebGLAvailable()` is false. Starts `true`
   *  (assume GL works) rather than calling `isWebGLAvailable()` during
   *  render: that function reads `document`, which is absent during SSR,
   *  so evaluating it at render time would make the server and the client's
   *  first hydration pass disagree on which markup to produce. Starting
   *  optimistic and correcting from an effect keeps the first render
   *  identical on both sides; a genuinely GL-less browser flips to the
   *  fallback one tick later instead of never matching hydration at all. */
  webglAvailable: boolean;
}

/**
 * Mounts (and keeps live) one `LampViewHandle` for the life of the
 * component. Returns the resolved honest state so `LampStage.tsx`'s DOM
 * layer (caption, reset, chooser) renders from the exact read the GL layer
 * already used, rather than recomputing it a second time and risking the
 * two diverging.
 */
export function useLampStage(params: UseLampStageParams): UseLampStageResult {
  const { containerRef, state, variant } = params;
  const reducedMotion = useReducedMotion();

  // See `UseLampStageResult.webglAvailable`'s doc comment for why this
  // starts `true` and is only ever corrected from an effect, never computed
  // during render.
  const [webglAvailable, setWebglAvailable] = React.useState(true);
  React.useEffect(() => {
    setWebglAvailable(isWebGLAvailable());
  }, []);

  // `DeviceSummary` has no `capabilities` field at all (api.ts's own doc
  // comment on the type); this is the exact guard `stage.tsx`'s
  // `zoneCountFor` already uses for the same reason, kept identical so the
  // two call sites never diverge on how they read it.
  const caps = "capabilities" in state ? state.capabilities : undefined;
  const layout = React.useMemo(() => layoutFromCapabilities(caps, state.model), [caps, state.model]);
  const layoutId = layoutKey(layout);
  const resolved = React.useMemo(() => resolveLampState(state), [state]);

  // Always-current values for the two effects below, without making either
  // depend on `resolved`/`reducedMotion`/`layout` directly — see this
  // module's own doc comment and `use-motion-stage.ts`'s identical pattern.
  const resolvedRef = React.useRef(resolved);
  resolvedRef.current = resolved;
  const reducedMotionRef = React.useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const modelRef = React.useRef(state.model);
  modelRef.current = state.model;

  const handleRef = React.useRef<LampViewHandle | null>(null);

  // Mount/unmount only. `model`/`layout` are read from the refs above at
  // the moment `mountLampView` actually runs rather than listed as
  // dependencies: `models/source.ts`'s `acquireModel` only consults
  // `layout` on the call that builds a fresh model for that model string,
  // so a later change would silently do nothing useful anyway, and every
  // call site that could change `state.model` for a mounted stage already
  // remounts the whole component by React key (the device page keys its
  // content by `ref`; dashboard plates are one per device in a keyed list)
  // rather than swapping props on a live instance. Depending on them here
  // would only buy a needless dispose/remount cycle on every capabilities
  // refetch that returns a new-but-equal object.
  //
  // Deliberately does NOT gate on `reducedMotion` or skip mounting under
  // it: the fallback rule is "the scene renders, materials and all" under
  // reduced motion, and dragging must still work — both require a real
  // mounted view. `renderer.ts` freezes this view's own sampled time
  // internally instead (its own `prefersReducedMotion()` check at mount),
  // which is what actually stops the LED field from animating.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !isWebGLAvailable()) return;

    const handle = mountLampView({
      element: container,
      clipTo: findScrollAncestor(container),
      model: modelRef.current,
      layout: layoutRef.current,
      tier: variant === "full" ? "hero" : "plate",
    });
    handleRef.current = handle;

    // Prime the view with whatever is already known before the shared
    // ticker's first tick reaches it, and force one immediate frame under
    // reduced motion — the fallback rule's "draw one frame on mount", since
    // a reduced-motion view never gets a second chance from an animating
    // ticker to correct a blank first paint.
    handle.setPower(resolvedRef.current.power);
    handle.setBrightness(resolvedRef.current.brightness);
    handle.setSpec(resolvedRef.current.spec);
    handle.setEffect(resolvedRef.current.effect);
    if (reducedMotionRef.current) handle.drawOnce();

    return () => {
      handle.dispose();
      handleRef.current = null;
    };
    // `layoutId` and `state.model` are real dependencies, not ref reads: the
    // LED texture is sized from the layout at mount, and capabilities can
    // arrive AFTER the first render — a dashboard summary carries none at all,
    // so the layout starts at the per-model fallback and can still change when
    // a fuller payload lands. Left out, a view that mounted before its matrix
    // was known stayed a single emitter for the rest of its life: a flat
    // colour where 132 emitters belong. A layout change is rare — once, if at
    // all — so remounting on one is both cheap and the correct response.
  }, [containerRef, variant, layoutId, state.model]);

  // Keeps the mounted view's per-frame inputs current on every state
  // change, without ever touching the mount effect above — the same split
  // `use-motion-stage.ts` draws between "subscribe once" and "read the
  // latest ref every tick", adapted to `LampViewHandle`'s explicit setters
  // since this hook has no draw closure of its own to close over a ref.
  React.useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setPower(resolved.power);
    handle.setBrightness(resolved.brightness);
    handle.setSpec(resolved.spec);
    handle.setEffect(resolved.effect);
    // Reduced motion draws exactly one frame per state change (the
    // fallback rule's other half). The shared ticker still runs
    // continuously for every mounted view regardless of this device's own
    // reduced-motion setting, but `renderer.ts` freezes this view's own
    // sampled time whenever it detected `prefers-reduced-motion` at mount,
    // so its appearance does not advance between the frames this line
    // forces.
    if (reducedMotion) handle.drawOnce();
  }, [resolved, reducedMotion]);

  return { resolved, webglAvailable };
}
