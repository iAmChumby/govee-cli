/**
 * One `WebGLRenderer` for the entire app. Every mounted lamp — the device
 * page's hero and every dashboard plate — is a scissor rectangle carved out
 * of this single shared canvas, per the design doc's "why one context
 * matters": context count stays at 1 regardless of how many cards are on
 * screen, and `driver.ts`'s `PLATE_CONCURRENCY_CAP` survives as a redraw
 * *budget* rather than a context cap.
 *
 * This module owns, lazily, on first `mountLampView()` call:
 *  - the shared `<canvas>` element and `WebGLRenderer` (decision 1: `fixed
 *    inset-0 pointer-events-none`, `alpha: true`, no `preserveDrawingBuffer`)
 *  - the view registry from `views.ts`
 *  - the shared `RoomEnvironment` PMREM (decision 5) every view's scene reads
 *    as `scene.environment`
 *  - the single `driver.ts` subscription for the whole module (decision 4) —
 *    nothing else in `lamp3d/` ever calls `subscribe()`
 *
 * and, per view, a `Scene`, a camera framed from the model's `fitRadius`, the
 * acquired (and shared-by-model-string) `LampModel`, a per-device LED
 * texture, and that view's own spill lights and halo. Everything disposable
 * is disposed on the matching `dispose()`; the shared renderer itself is
 * disposed when the last view unmounts.
 *
 * **What is and isn't unit-tested here.** `isWebGLAvailable`, `SLOW_TIER_INTERVAL_MS`
 * / `dueForSlowRedraw`, and the module's lazy-init discipline (nothing touches
 * `document`/`WebGLRenderer` at import time or before the first `mountLampView`
 * call) are plain functions/invariants and are covered by `renderer.test.ts`
 * in the default Node environment. The rest of this file — actually creating
 * a `WebGLRenderer`, scissoring real draw calls, reparenting `object3D`
 * across scenes — needs a live GL context and is covered by the browser
 * verification pass (`scripts/verify_ui.py`), not vitest; see `cast-light.ts`
 * and `controls.ts` for the same boundary drawn in their own files.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  CircleGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  Box3,
  WebGLRenderer,
  type PointLight,
  type Sprite,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { EffectDescriptor, MotionSpec } from "@/lib/motion-engine/types";
import { PLATE_CONCURRENCY_CAP, subscribe } from "@/lib/motion-engine/driver";
import { clearLedField, evaluateLedField, writeEffectFrame } from "./led-field";
import { acquireModel, releaseModel, setDiffuserQuality } from "./models/source";
import type { LampModel, LedLayout } from "./models/types";
import { applyEmission, brightnessGlow, createLedTexture, type LedTexture } from "./emission";
import {
  createHalo,
  createSpillLights,
  getRadialFalloffTexture,
  meanAllLedColor,
  SPILL_LIGHT_LAYER,
  updateHalo,
  updateSpillLights,
} from "./cast-light";
import { attachOrbitControls, sphericalOffset, type OrbitHandle } from "./controls";
import {
  clampScissor,
  createViewRegistry,
  cssSize,
  deviceSize,
  intersectRect,
  isOnScreen,
  scissorFromRect,
  type CssSize,
  type ScreenRect,
  type ViewRegistry,
} from "./views";

/* ------------------------------------------------------------ WebGL probe */

let webglAvailable: boolean | null = null;

/**
 * Detects WebGL support once and caches the result — the design doc's
 * required fallback path: `LampStage` (a later module) calls this before
 * ever calling `mountLampView`, and renders a static CSS silhouette instead
 * when it's `false`, rather than the resurrected 1161-line 2D stage.
 *
 * Probes with a throwaway canvas/context rather than trying `mountLampView`
 * itself and catching failure, so a caller can check this *before* doing any
 * of the per-view setup work below.
 */
export function isWebGLAvailable(): boolean {
  if (webglAvailable !== null) return webglAvailable;
  if (typeof document === "undefined") {
    webglAvailable = false;
    return false;
  }
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    webglAvailable = gl !== null;
  } catch {
    webglAvailable = false;
  }
  return webglAvailable;
}

/* --------------------------------------------------------- shared module state */

let sharedRenderer: WebGLRenderer | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedRegistry: ViewRegistry | null = null;
let sharedEnvTexture: Texture | null = null;
let unsubscribeTicker: (() => void) | null = null;
let mountedViewCount = 0;

/** Ground plane geometry/material are generic scenery, not model-specific —
 *  unlike `LampModel`s (per-model, refcounted, potentially large), these are
 *  one flat circle and one material referencing the tiny shared radial
 *  texture from `cast-light.ts`. Kept alive for the life of the module
 *  rather than torn down with the renderer: recreating them on every
 *  mount/unmount cycle would add teardown-ordering risk for no measurable
 *  memory benefit. */
let sharedGroundGeometry: CircleGeometry | null = null;
let sharedGroundMaterial: MeshStandardMaterial | null = null;

function getGroundGeometry(): CircleGeometry {
  if (!sharedGroundGeometry) {
    sharedGroundGeometry = new CircleGeometry(1, 48);
  }
  return sharedGroundGeometry;
}

function getGroundMaterial(): MeshStandardMaterial {
  if (!sharedGroundMaterial) {
    sharedGroundMaterial = new MeshStandardMaterial({
      // Overwritten immediately by `syncGroundToTheme()`; see there for why the
      // surface takes the panel's own colour rather than a fixed one.
      color: 0x2c2c31,
      roughness: 0.92,
      metalness: 0,
      transparent: true,
      alphaMap: getRadialFalloffTexture(),
      depthWrite: false,
    });
  }
  syncGroundToTheme();
  return sharedGroundMaterial;
}

/**
 * Paints the ground the same colour as the panel it sits on, read from the
 * `--raised` design token.
 *
 * A fixed dark ground is invisible on a dark stage and a black slab on a light
 * one — which is exactly how it shipped into the first light-theme screenshot:
 * a hard black shape filling the lower half of a white card. Taking the panel's
 * own colour makes the surface vanish into the card until something lights it,
 * so what a person actually sees is the cast light and the contact shadow
 * rather than a disc. That also means it is correct in both themes for the same
 * reason, instead of being tuned twice.
 *
 * Read on demand and on theme change only — `next-themes` toggles a class on
 * `<html>`, so a MutationObserver costs nothing per frame, and
 * `getComputedStyle` is a layout read this render path should not be doing 60
 * times a second.
 */
function syncGroundToTheme(): void {
  if (!sharedGroundMaterial || typeof document === "undefined") return;
  const token = getComputedStyle(document.documentElement).getPropertyValue("--raised").trim();
  if (token) sharedGroundMaterial.color.set(token);
}

let themeObserver: MutationObserver | null = null;

function watchTheme(): void {
  if (themeObserver || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(syncGroundToTheme);
  themeObserver.observe(document.documentElement, { attributeFilter: ["class", "style", "data-theme"] });
}

/** Device pixel ratio cap — three's own recommendation for mobile GPU cost,
 *  and doubly relevant here since `MeshPhysicalMaterial.transmission`
 *  (the frosted diffusers) renders a full extra pass per pixel. */
const MAX_DPR = 2;

/** How long a `slow`-tier plate holds its last frame before it is allowed to
 *  redraw again — "about 4fps" per the design doc's performance budget
 *  (`1000 / 250 = 4`). Exported and driven through a pure predicate
 *  (`dueForSlowRedraw`) specifically so the cadence decision itself — not
 *  just "some interval exists" — is unit-testable without a renderer. */
export const SLOW_TIER_INTERVAL_MS = 250;

export function dueForSlowRedraw(lastDrawnAtMs: number, nowMs: number): boolean {
  return nowMs - lastDrawnAtMs >= SLOW_TIER_INTERVAL_MS;
}

/* ------------------------------------------------------------- camera framing */

/** Camera distance from the orbit target, relative to the model's own
 *  `fitRadius` — proportional so the hero and a plate of the same model
 *  frame identically regardless of on-screen pixel size. */
/** The scale `computeFrameRects` works at. three applies the renderer's real
 *  pixel ratio itself, so this module hands it CSS pixels — see that function. */
const CSS_PIXEL_RATIO = 1;

const CAMERA_FOV_DEGREES = 35;

/** A little air around the body so it never touches the stage's edges. */
const CAMERA_FIT_MARGIN = 1.06;
/** Fraction of the model's height the orbit target sits at — slightly below
 *  true center, which reads as a more natural "looking at the object"
 *  framing than dead-center or eye-level-with-the-base. */
const TARGET_HEIGHT_FRACTION = 0.42;
const INITIAL_AZIMUTH = Math.PI * 0.18;
const INITIAL_ELEVATION = 0.32;
/**
 * The exposure budget, and why these numbers are this low.
 *
 * The spec's whole claim is that the LEDs ARE the light source. That only holds
 * if the body is DARK before they turn on. The first working render had a
 * near-white diffuser under a bright `RoomEnvironment` plus a 0.55 ambient and a
 * 1.1 key: the shade reached display white on its own, and adding emission on
 * top of an already-saturated surface changed nothing a person could see. Both
 * a DIY scene on the drum and a 48-LED music mode on the bars rendered as flat
 * white capsules — the exact "generic pastel wash" the spec was written to
 * eliminate, arrived at from the opposite direction.
 *
 * So the ambient, the key and the environment are all pulled down to leave the
 * unlit body around a quarter of display range: enough for the metal base to
 * catch a highlight and for the object to read as real when it is off, with the
 * rest of the range left for the emitters to claim.
 */
const AMBIENT_INTENSITY = 0.16;
const KEY_LIGHT_INTENSITY = 0.5;

/** How much of the shared `RoomEnvironment` reaches the materials. Full
 *  strength is a photographic studio; the console is a dark room with a lamp
 *  in it. */
const ENVIRONMENT_INTENSITY = 0.32;
const GROUND_SCALE_FACTOR = 2.4;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- renderer lifecycle */

function ensureRendererReady(): { renderer: WebGLRenderer; canvas: HTMLCanvasElement; registry: ViewRegistry } {
  if (sharedRenderer && sharedCanvas && sharedRegistry) {
    return { renderer: sharedRenderer, canvas: sharedCanvas, registry: sharedRegistry };
  }
  if (!isWebGLAvailable()) {
    throw new Error("lamp3d/renderer: WebGL is not available; callers must check isWebGLAvailable() first");
  }

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  // Decision 1: fixed, full-viewport, click-through, above app content
  // (z-10) but below Radix dialogs (z-50) and the toaster (z-[100]).
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "10";
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  // Alpha-transparent clear (decision 1) so only geometry paints and the
  // stage's own rounded corners stay clean; preserveDrawingBuffer is left at
  // its default `false` per that same decision.
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  // Without tone mapping, everything above 1.0 hard-clips to white — so a
  // saturated red LED at full brightness and a white one render identically,
  // which defeats the point of driving emission from real colour. ACES rolls
  // the highlights off instead, so a bright emitter stays the colour it is
  // and only its intensity climbs.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setPixelRatio(Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, MAX_DPR));

  const pmremGenerator = new PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTexture = pmremGenerator.fromScene(roomEnv, 0.04).texture;
  roomEnv.dispose();
  pmremGenerator.dispose();

  const registry = createViewRegistry();

  sharedRenderer = renderer;
  sharedCanvas = canvas;
  sharedRegistry = registry;
  sharedEnvTexture = envTexture;

  // Decision 4: exactly one driver.ts subscription for the whole module,
  // regardless of how many views are mounted. Registered as priority
  // "hero" — this subscriber drives every tier internally via its own
  // registry/budget, so it must never be subject to driver.ts's *plate*
  // concurrency cap the way an individual 2D plate stage would be.
  unsubscribeTicker = subscribe({
    id: "lamp3d-renderer",
    priority: "hero",
    draw: (_ctx, t) => renderFrame(t),
  });

  return { renderer, canvas, registry };
}

function teardownRenderer(): void {
  unsubscribeTicker?.();
  unsubscribeTicker = null;
  sharedEnvTexture?.dispose();
  sharedEnvTexture = null;
  sharedRenderer?.dispose();
  sharedCanvas?.remove();
  sharedRenderer = null;
  sharedCanvas = null;
  sharedRegistry = null;
}

function ensureCanvasSize(renderer: WebGLRenderer, canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cssWidth = canvas.clientWidth || window.innerWidth;
  const cssHeight = canvas.clientHeight || window.innerHeight;
  const wantWidth = Math.round(cssWidth * dpr);
  const wantHeight = Math.round(cssHeight * dpr);
  if (canvas.width === wantWidth && canvas.height === wantHeight && renderer.getPixelRatio() === dpr) return;
  renderer.setPixelRatio(dpr);
  // updateStyle = false: this canvas's CSS box is already fully controlled
  // by the fixed-inset-0 styling set in ensureRendererReady(); three
  // overwriting canvas.style.width/height here would fight that rather than
  // cooperate with it.
  renderer.setSize(cssWidth, cssHeight, false);
}

/* -------------------------------------------------------------------- view state */

interface ViewState {
  id: string;
  tier: "hero" | "plate";
  element: HTMLElement;
  /** Mirrors `MountLampViewOptions.clipTo`, kept on the view state so
   *  `drawViewImmediate` can apply the same `clipTo` intersection the
   *  registry's own `readBoxes()` does, rather than measuring only its own
   *  element and painting past a clipping ancestor. */
  clipTo: HTMLElement | null;
  model: LampModel;
  modelKey: string | null;
  layout: LedLayout;
  scene: Scene;
  camera: PerspectiveCamera;
  target: Vector3;
  radius: number;
  ledTex: LedTexture;
  spillLights: PointLight[];
  halo: Sprite;
  ground: Mesh;
  ambient: AmbientLight;
  keyLight: DirectionalLight;
  orbit: OrbitHandle | null;
  spec: MotionSpec | null;
  effect: EffectDescriptor | null;
  power: boolean;
  brightness: number | null;
  reducedMotion: boolean;
  frozenT: number;
  lastSlowDrawAt: number;
  disposed: boolean;
}

const viewStates = new Map<string, ViewState>();
let nextViewId = 0;

export interface LampViewHandle {
  setSpec(spec: MotionSpec | null): void;
  setEffect(effect: EffectDescriptor | null): void;
  setPower(power: boolean): void;
  setBrightness(b: number | null): void;
  /** Renders this view immediately, outside the shared ticker's own
   *  scheduling — used for `prefers-reduced-motion`'s "a single frame is
   *  drawn on mount and on state change" rule, and as a general
   *  force-a-redraw escape hatch. Measures a fresh `getBoundingClientRect()`
   *  rather than waiting for the registry's next `readBoxes()` pass, since a
   *  caller reaching for this wants the current frame, not next tick's. */
  drawOnce(): void;
  dispose(): void;
}

export interface MountLampViewOptions {
  element: HTMLElement;
  clipTo?: HTMLElement | null;
  model: string | null;
  layout: LedLayout;
  tier: "hero" | "plate";
}

/**
 * Registers a new lamp view against the shared renderer, creating the
 * renderer itself on the very first call. Throws if `isWebGLAvailable()` is
 * false or context creation otherwise fails — callers (a later
 * `use-lamp-stage.ts`) are expected to check `isWebGLAvailable()` first and
 * fall back to the static silhouette rather than call this at all.
 */
export function mountLampView(opts: MountLampViewOptions): LampViewHandle {
  const { registry } = ensureRendererReady();

  const model = acquireModel(opts.model, opts.layout);
  // The shared model's own layout — not necessarily `opts.layout` verbatim.
  // `models/source.ts`'s `acquireModel` only consults `layout` on the call
  // that builds a fresh model; a later mount of an already-cached model
  // must evaluate the LED field against the layout the shared `object3D`
  // was actually built with; see `LedTexture` below.
  const layout = model.layout;
  const ledTex = createLedTexture(layout);

  const scene = new Scene();
  scene.environment = sharedEnvTexture;
  scene.environmentIntensity = ENVIRONMENT_INTENSITY;

  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 0.05, 100);
  const targetHeight = model.height * TARGET_HEIGHT_FRACTION;
  const target = new Vector3(0, targetHeight, 0);
  // The box isn't registered with `views.ts` yet (that happens below), so
  // there's no `StageView.box` to read; measure the element directly, the
  // same one-off DOM read `drawViewImmediate` already does elsewhere in this
  // file. A box with no layout yet (zero width or height — e.g. this stage's
  // container hasn't been sized by CSS on the very first paint) can't yield a
  // trustworthy aspect ratio, so it falls back to 1 (square), which is
  // exactly the ratio at which `cameraFitDistance`'s vertical- and
  // horizontal-FOV constraints agree — a safe, neutral default rather than a
  // guess at the real box shape.
  const mountRect = opts.element.getBoundingClientRect();
  const initialAspect = mountRect.width > 0 && mountRect.height > 0 ? mountRect.width / mountRect.height : 1;
  const radius = cameraFitDistance(measureFitExtent(model, targetHeight), initialAspect);
  const [ox, oy, oz] = sphericalOffset(INITIAL_AZIMUTH, INITIAL_ELEVATION, radius);
  camera.position.set(target.x + ox, target.y + oy, target.z + oz);
  camera.lookAt(target);

  const ambient = new AmbientLight(0xffffff, AMBIENT_INTENSITY);
  const keyLight = new DirectionalLight(0xffffff, KEY_LIGHT_INTENSITY);
  keyLight.position.set(model.fitRadius * 1.6, model.height * 1.7 + 0.5, model.fitRadius * 1.1);
  keyLight.target.position.set(0, targetHeight, 0);
  scene.add(ambient, keyLight, keyLight.target);

  watchTheme();
  const ground = new Mesh(getGroundGeometry(), getGroundMaterial());
  // Joins the spill layer as well as the default one, so it is drawn normally
  // AND catches the cast light the emitters throw — see cast-light.ts's
  // SPILL_LIGHT_LAYER. Everything else in the scene stays on layer 0 alone.
  ground.layers.enable(SPILL_LIGHT_LAYER);
  ground.rotation.x = -Math.PI / 2;
  ground.scale.setScalar(Math.max(model.fitRadius, 0.01) * GROUND_SCALE_FACTOR);
  ground.position.set(0, 0, 0);
  scene.add(ground);

  const spillLights = createSpillLights(model);
  scene.add(...spillLights);

  const halo = createHalo(model);
  scene.add(halo);

  const orbit =
    opts.tier === "hero"
      ? attachOrbitControls({
          element: opts.element,
          camera,
          target,
          radius,
          initialAzimuth: INITIAL_AZIMUTH,
          initialElevation: INITIAL_ELEVATION,
        })
      : null;

  const view: ViewState = {
    id: `lamp-${nextViewId++}`,
    tier: opts.tier,
    element: opts.element,
    clipTo: opts.clipTo ?? null,
    model,
    modelKey: opts.model,
    layout,
    scene,
    camera,
    target,
    radius,
    ledTex,
    spillLights,
    halo,
    ground,
    ambient,
    keyLight,
    orbit,
    spec: null,
    effect: null,
    power: false,
    brightness: null,
    reducedMotion: prefersReducedMotion(),
    frozenT: 0,
    lastSlowDrawAt: 0,
    disposed: false,
  };
  viewStates.set(view.id, view);

  const unregister = registry.register({
    id: view.id,
    element: opts.element,
    tier: opts.tier,
    clipTo: opts.clipTo ?? undefined,
  });

  mountedViewCount++;

  return {
    setSpec(spec: MotionSpec | null): void {
      view.spec = spec;
      if (spec) view.effect = null;
      if (view.reducedMotion) {
        view.frozenT = typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
      }
    },
    setEffect(effect: EffectDescriptor | null): void {
      view.effect = effect;
      if (effect) view.spec = null;
    },
    setPower(power: boolean): void {
      view.power = power;
    },
    setBrightness(b: number | null): void {
      view.brightness = b;
    },
    drawOnce(): void {
      drawViewImmediate(view);
    },
    dispose(): void {
      if (view.disposed) return;
      view.disposed = true;
      orbit?.dispose();
      unregister();
      viewStates.delete(view.id);
      releaseModel(view.modelKey);
      ledTex.texture.dispose();
      halo.material.dispose();
      scene.remove(ground, halo, ambient, keyLight, keyLight.target, ...spillLights);
      if (model.object3D.parent === scene) {
        scene.remove(model.object3D);
      }
      mountedViewCount--;
      if (mountedViewCount <= 0) {
        mountedViewCount = 0;
        teardownRenderer();
      }
    },
  };
}

/* ----------------------------------------------------------------- per-frame draw */

/** Everything a single view's draw call needs about its own on-screen box —
 *  computed once per frame per drawn view and threaded through so
 *  `drawView`/`drawViewImmediate` never disagree on how a box became a
 *  scissor rect. */
export interface FrameRects {
  viewportX: number;
  viewportY: number;
  viewportW: number;
  viewportH: number;
  scissorX: number;
  scissorY: number;
  scissorW: number;
  scissorH: number;
  aspect: number;
}

/**
 * Rects for one view, in CSS pixels — which is what three's own API wants.
 *
 * `WebGLRenderer.setViewport`/`setScissor` multiply whatever they are given by
 * the renderer's pixel ratio before reaching `gl.viewport`/`gl.scissor`. Handing
 * them device pixels therefore applies the ratio TWICE. On a desktop at dpr 1
 * the two units are identical and nothing looks wrong; on a phone at dpr 2 the
 * rect lands at four times the area and the lamp is drawn entirely off-screen —
 * the stage renders as an empty box, while the canvas as a whole still changes
 * every frame, so a "does the canvas animate" check passes throughout. That is
 * how this shipped past one round of verification, and why the flip and the
 * clamp below are both computed at `dpr = 1`.
 *
 * `views.ts` is right to work in device pixels: it is a general utility and the
 * flip needs a concrete buffer height. Choosing CSS units is this module's
 * business, because this module is the one talking to three.
 *
 * Takes two rects, not one — this is the fix for a real bug, not defensive
 * plumbing. `box` and `clipBox` are `StageView.box`/`StageView.clipBox`: `box`
 * is a view's own full element rect, and `clipBox` is that rect intersected
 * with its `clipTo` scrolling ancestor (see `views.ts`). Before this split,
 * `views.ts` handed this function only the intersected rect, and this function
 * derived BOTH the viewport and the scissor from that one shrinking rect. A
 * plate scrolling under the fixed `TopBar` then had its camera's viewport and
 * `aspect` recomputed every frame from the shrinking visible sliver — not just
 * clipped, but reframed — so the lamp visibly squashed and shrank as it
 * scrolled. Decision 3's intent (see the design doc) was always that the FULL
 * rect frames the camera and only the CLAMPED rect limits painted pixels; using
 * the clipped rect for both defeats that on any view with a `clipTo`, which is
 * every plate on the dashboard.
 */
export function computeFrameRects(box: ScreenRect, clipBox: ScreenRect, canvasCss: CssSize): FrameRects | null {
  if (box.width <= 0 || box.height <= 0) return null;
  if (clipBox.width <= 0 || clipBox.height <= 0) return null;
  // The viewport (and the aspect derived from it) come from the FULL,
  // unclipped box: a view scrolled half under its clipping ancestor is still
  // framed as if its whole box were visible.
  const full = scissorFromRect(box, canvasCss, CSS_PIXEL_RATIO);
  // The scissor — what actually limits painted pixels — comes from the
  // CLIPPED box instead, then gets clamped to the drawing buffer's own
  // bounds as a second, independent limit (defensive: a `clipTo` ancestor
  // lives inside the viewport already, so this rarely trims anything beyond
  // what the clip already did, but a view whose box legitimately hangs off
  // the canvas edge — no `clipTo` at all — still needs it).
  const clipScissor = scissorFromRect(clipBox, canvasCss, CSS_PIXEL_RATIO);
  const clamped = clampScissor(clipScissor, deviceSize(canvasCss.width, canvasCss.height));
  if (!clamped) return null;
  return {
    viewportX: full.x,
    viewportY: full.y,
    viewportW: full.width,
    viewportH: full.height,
    scissorX: clamped.x,
    scissorY: clamped.y,
    scissorW: clamped.width,
    scissorH: clamped.height,
    aspect: box.width / box.height,
  };
}

/**
 * Advances and draws exactly one view: evaluates its LED field, uploads the
 * texture, recolours its spill lights and halo, reparents the shared model
 * body into this view's own scene, and issues one scissored `renderer.render`
 * call. Shared by the main per-frame loop (`renderFrame`) and by
 * `drawViewImmediate` (the `drawOnce()` escape hatch) so there is exactly one
 * implementation of "how a view actually draws."
 */
/**
 * How far the camera must sit from the orbit target for the whole body to fit.
 *
 * Derived rather than dialled in, and from the body's real BOUNDING BOX about
 * the orbit target (`measureFitExtent`) rather than from a bounding sphere.
 * A sphere was the previous basis and it framed wide bodies badly: it is
 * driven by the object's largest dimension in any direction, so the H6056's
 * pair of bars — much wider than tall — was fitted as though it were as tall
 * as it is wide, and rendered small with a band of empty stage above and
 * below it. The camera also looks at `TARGET_HEIGHT_FRACTION` of the height,
 * deliberately below centre, so the extent is measured about that target
 * rather than about the body's own mid-height.
 *
 * `CAMERA_FOV_DEGREES` (three's `PerspectiveCamera.fov`) is always the
 * VERTICAL field of view; the horizontal one is derived from it via `aspect`
 * (`tan(hHalf) = tan(vHalf) * aspect`). For aspect >= 1 (every stage box in
 * this app today — the hero is 342x260 on a phone and 504x380 on a desktop;
 * plates are 4:3) the horizontal half-angle is >= the vertical one, so
 * `sin(hHalf) >= sin(vHalf)` and the vertical term alone gives the larger,
 * binding, distance — which is what the old single-term formula computed and
 * why it was correct for every box that has ever existed here.
 *
 * Taking `Math.max` of the vertical-only and horizontal-only distances (the
 * added `distanceForH` term below) keeps that correct AND removes the
 * silent "no box is ever taller than wide" dependency the single-term
 * version carried: for aspect < 1 the horizontal half-angle becomes the
 * SMALLER one, `distanceForH` becomes the larger distance, and `Math.max`
 * picks it up automatically rather than cropping the sides. For aspect >= 1
 * this produces the exact same number as before — one extra `atan`/`sin`
 * pair and one `Math.max`, not a behaviour change for any box that exists.
 *
 * `aspect` is measured once, at mount, from the view's own element (see the
 * call site) — `views.ts`'s registry hasn't measured a `StageView.box` yet
 * at that point, and the orbit controls close over the resulting radius as a
 * single value for the view's lifetime rather than recomputing it as the box
 * resizes, matching the existing "one radius, not per-frame" design (a mid
 * session recompute would also fight a user who has already orbited/zoomed).
 * A view whose aspect flips from >=1 to <1 after mount (a hero rotated on a
 * device that supports it, say) is not re-fit; nothing in this app does that
 * today, and this comment is the record of that residual assumption.
 */
export interface FitExtent {
  /** Greatest horizontal distance from the orbit axis to any point of the
   *  body, i.e. `max(hypot(x, z))` over the bounding box's corners. Taken at
   *  the worst azimuth rather than per-orbit-angle, so a body stays framed
   *  through a full rotation instead of clipping as it turns side-on. */
  radiusXZ: number;
  /** Greatest vertical distance from the orbit TARGET to the top or the bottom
   *  of the body — not half the height, because the target deliberately sits
   *  below centre. */
  halfHeight: number;
}

/**
 * The body's real extent, about the orbit target, from the geometry the
 * renderer is actually going to draw.
 *
 * `Box3.setFromObject` walks every mesh's world-transformed geometry, so this
 * needs no cooperation from the model files and is automatically right for a
 * model whose parts are rotated or offset — the H6056's bars are pitched in
 * their yokes and toed in toward each other, and no constant in that file
 * describes the resulting silhouette.
 *
 * `updateMatrixWorld(true)` first: three only refreshes matrices during a
 * render, and this runs at mount, long before the first frame.
 */
function measureFitExtent(model: LampModel, targetY: number): FitExtent {
  model.object3D.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model.object3D);
  if (box.isEmpty()) {
    // Nothing measurable (a model built with no meshes should not exist, but a
    // zero-area box would divide the framing math by nothing). Fall back to the
    // model's self-reported sphere, which is always populated.
    return { radiusXZ: model.fitRadius, halfHeight: model.fitRadius };
  }
  const xs = [box.min.x, box.max.x];
  const zs = [box.min.z, box.max.z];
  let radiusXZ = 0;
  for (const x of xs) {
    for (const z of zs) {
      radiusXZ = Math.max(radiusXZ, Math.hypot(x, z));
    }
  }
  return {
    radiusXZ,
    halfHeight: Math.max(box.max.y - targetY, targetY - box.min.y),
  };
}

export function cameraFitDistance(extent: FitExtent, aspect: number): number {
  const halfFovV = (CAMERA_FOV_DEGREES * Math.PI) / 360;
  const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
  // `tan`, not `sin`: `r / sin(halfFov)` is the tangency distance for a
  // SPHERE of radius r, and that is what this used to compute. A sphere is a
  // loose bound for every body here — the H6056 is a pair of bars 2.8 wide and
  // 2.4 tall, whose enclosing sphere is driven entirely by its width, so
  // fitting that sphere vertically pushed the camera far enough back that the
  // bars filled barely half the frame's height and read as small and far away.
  // Fitting the box's two half-extents against their own axes instead is what
  // a person means by "frame the object".
  //
  // `+ radiusXZ` on both terms is the near-side correction: the closest point
  // of the body sits that much nearer the camera than the orbit axis does, and
  // a distance measured to the axis alone would let the near edge push out of
  // frame.
  const distanceForV = extent.halfHeight / Math.tan(halfFovV) + extent.radiusXZ;
  const distanceForH = extent.radiusXZ / Math.tan(halfFovH) + extent.radiusXZ;
  return Math.max(distanceForV, distanceForH) * CAMERA_FIT_MARGIN;
}

function drawView(view: ViewState, rects: FrameRects, tSeconds: number, nowMs: number): void {
  const renderer = sharedRenderer;
  if (!renderer) return;

  const buffer = view.ledTex.buffer;
  if (view.effect) {
    writeEffectFrame(view.effect, view.layout, nowMs, buffer);
  } else if (view.spec) {
    const t = view.reducedMotion ? view.frozenT : tSeconds;
    evaluateLedField(view.spec, view.layout, t, buffer);
  } else {
    // No spec and no effect is the ledger's "unknown" case (or simply "off"
    // with nothing else set yet) — zeroed LEDs, no colour, no motion, per
    // the design doc's rule 1. `applyEmission` below also zeroes on
    // `!power`, but doing it here too means a genuinely unknown mode reads
    // as unlit even if a caller passes `power: true` for it.
    clearLedField(buffer);
  }

  // The gain `applyEmission` returns is this frame's exposure lift (see
  // `emission.ts`'s `frameNormalizeGain`). Threading it into the cast light
  // and the halo below — rather than letting each recompute it — is what
  // keeps the light a lamp throws at the same exposure as the lamp itself.
  // An indeterminate palette opts OUT of exposure normalization. Its whole
  // point is to assert nothing, and normalizing its neutral grey lifts the
  // peak to 255 — a bright white lamp, which is a state this hardware really
  // can be in. The render would stop saying "we don't know what colour this
  // scene is" and start saying "it is white". See `uploadLedFrame`.
  const frameGain = applyEmission(
    view.model,
    view.ledTex,
    view.power,
    view.brightness,
    view.spec?.paletteBasis !== "indeterminate",
  );
  setDiffuserQuality(view.model, view.tier);

  const brightnessFactor = view.power ? brightnessGlow(view.brightness) : 0;
  updateSpillLights(view.spillLights, view.model, buffer, brightnessFactor, frameGain);
  updateHalo(view.halo, meanAllLedColor(buffer), brightnessFactor, frameGain);

  // Reparent the shared body into this view's scene immediately before
  // drawing it — see models/source.ts's module doc comment for why this is
  // the one point in the frame where it's safe: the renderer never draws two
  // views in the same call, so exactly one scene legitimately owns
  // `object3D` "at a time".
  view.scene.add(view.model.object3D);

  if (Number.isFinite(rects.aspect) && rects.aspect > 0) {
    view.camera.aspect = rects.aspect;
    view.camera.updateProjectionMatrix();
  }

  renderer.setScissorTest(true);
  renderer.setViewport(rects.viewportX, rects.viewportY, rects.viewportW, rects.viewportH);
  renderer.setScissor(rects.scissorX, rects.scissorY, rects.scissorW, rects.scissorH);
  // Clearing is itself bounded by the scissor rect while scissor test is
  // enabled, so this only ever erases this view's own rect — never another
  // view's already-drawn pixels or a `slow`-tier view's held-over frame.
  renderer.clear(true, true, true);
  renderer.render(view.scene, view.camera);
}

function renderFrame(tSeconds: number): void {
  const renderer = sharedRenderer;
  const canvas = sharedCanvas;
  const registry = sharedRegistry;
  if (!renderer || !canvas || !registry) return;

  ensureCanvasSize(renderer, canvas);

  const nowMs = tSeconds * 1000;
  const canvasCss = cssSize(canvas.clientWidth, canvas.clientHeight);

  registry.readBoxes(canvasCss, nowMs);
  const { active, slow } = registry.drawSets(PLATE_CONCURRENCY_CAP, nowMs);

  for (const stageView of active) {
    const view = viewStates.get(stageView.id);
    if (!view || !stageView.box || !stageView.clipBox) continue;
    const rects = computeFrameRects(stageView.box, stageView.clipBox, canvasCss);
    if (!rects) continue;
    drawView(view, rects, tSeconds, nowMs);
  }

  for (const stageView of slow) {
    const view = viewStates.get(stageView.id);
    if (!view || !stageView.box || !stageView.clipBox) continue;
    if (!dueForSlowRedraw(view.lastSlowDrawAt, nowMs)) continue;
    const rects = computeFrameRects(stageView.box, stageView.clipBox, canvasCss);
    if (!rects) continue;
    view.lastSlowDrawAt = nowMs;
    drawView(view, rects, tSeconds, nowMs);
  }
}

/** `drawOnce()`'s implementation: measures the view's own current box
 *  directly (bypassing the registry's cached box) rather than waiting for
 *  the next tick's `readBoxes()` — appropriate for an explicit "draw right
 *  now" request. It still applies the same `clipTo` intersection the
 *  registry does: the view's element box frames the camera unclipped (same
 *  reasoning as `computeFrameRects`), but the box actually painted is that
 *  rect intersected with `view.clipTo`'s own current box, so this escape
 *  hatch cannot paint past a scrolling ancestor's edge even on its one
 *  immediate call. Silently does nothing if the view is currently fully
 *  off-canvas (by its clipped box) or the renderer isn't ready yet — the
 *  same "no area, no draw" stance `views.ts` takes everywhere else. */
function drawViewImmediate(view: ViewState): void {
  const renderer = sharedRenderer;
  const canvas = sharedCanvas;
  if (!renderer || !canvas || view.disposed) return;

  const rect = view.element.getBoundingClientRect();
  const box: ScreenRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  let clipBox: ScreenRect = box;
  if (view.clipTo) {
    const clipRect = view.clipTo.getBoundingClientRect();
    const intersected = intersectRect(box, {
      left: clipRect.left,
      top: clipRect.top,
      width: clipRect.width,
      height: clipRect.height,
    });
    clipBox = intersected ?? { left: box.left, top: box.top, width: 0, height: 0 };
  }
  const canvasCss = cssSize(canvas.clientWidth, canvas.clientHeight);
  if (!isOnScreen(clipBox, canvasCss)) return;

  const rects = computeFrameRects(box, clipBox, canvasCss);
  if (!rects) return;

  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const tSeconds = nowMs / 1000;
  drawView(view, rects, tSeconds, nowMs);
}
