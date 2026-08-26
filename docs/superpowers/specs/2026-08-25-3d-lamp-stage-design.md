# 3D Lamp Stage — Design

**Date:** 2026-08-25
**Status:** approved design, not yet planned
**Supersedes:** `WEBUI_V3_SPEC.md` §4.1–§4.3's Canvas2D motion stage

---

## Problem

The console draws each device as hand-built SVG/CSS shapes: a rounded rectangle
for the H6022's drum, two capsules for the H6056's bars, a circle for the H6008.
Over that sits a Canvas2D "motion texture" layer that fills the shape's bounding
region with gradients.

Two consequences, both reported from the running console:

1. **The shape is arbitrary.** It is a flat silhouette with a lighter shape
   overlaid, not a model of the object. The H6022 in particular reads as a
   rounded rectangle with a second rounded rectangle floating inside it.
2. **The light is smeared, not simulated.** `canvas-renderer.ts` paints
   many-stop radial gradients across a 2D region. The H6022 is physically 132
   LEDs on a wrapped 12x11 matrix and the H6056 is 2x48; none of that geometry
   reaches the render, so a DIY scene becomes a generic pastel wash rather than
   light leaving specific emitters.

## Goals

- Each device renders as a **3D model** the user can rotate.
- The **LEDs are the light source**: per-LED emission at real positions, driven
  by the same `MotionSpec` the current engine already produces.
- The **cast light falls out of the emission** — bloom and surface spill are
  computed from the LED field, not art-directed separately.
- The object **holds up when off or dim**: diffuser translucency, plastic and
  metal materials, a surface underneath, soft shadows.
- Hero (device page) **and** every grid plate get the model.

## Non-goals

- **Segment picking.** `DeviceStage`'s `interactive` / `selected` /
  `onSelectionChange` / `onPaintSegments` / `matrixCells` props are used by no
  call site today (verified: `page.tsx:126` and `device-plate.tsx:349` are the
  only mounts, both display-only; the paint studio uses its own
  `canvas-grid.tsx`). The 3D stage ships display-only. 3D raycast picking is a
  later addition if the paint studio ever wants the stage as an input surface.
- **Orbit controls on grid plates.** Plates are wrapped in a `<Link>`; a drag
  would fight navigation. Plates render the model statically. The hero orbits.
- **Physically accurate photometry.** This is a convincing render, not a
  luminaire simulation. No IES profiles, no measured lumens.
- **New API surface.** Everything needed is already on the wire.

## Approach

Raw **three.js**, driven by the existing global ticker (`driver.ts`), with **one
`WebGLRenderer` shared by every mounted stage** via scissor rectangles.

Rejected alternatives:

- **React Three Fiber + drei `<View>`** — same shared-canvas result with far less
  plumbing, but R3F owns a render loop per `<Canvas>`. This codebase deliberately
  runs one rAF ticker with hero/plate tiering; introducing a second animation
  authority (or neutering R3F's with `frameloop="never"`) trades a real
  architectural property for convenience. Bundle roughly doubles.
- **R3F hero + raw-three plates** — two renderers and two sets of material code
  that would visibly diverge.

### Why one context matters

`driver.ts` caps concurrent plate canvases at `PLATE_CONCURRENCY_CAP = 4`
because each Canvas2D stage acquires its own context and a long dashboard grid
would spin up dozens on one iPhone Safari session. With a single shared
`WebGLRenderer` and per-view scissor rects, context count is 1 regardless of how
many cards are on screen. The cap survives as a *render budget* (how many views
redraw per frame), not a context cap.

---

## Architecture

```
lib/lamp3d/
  renderer.ts        one WebGLRenderer; view registry; scissored draw pass
  views.ts           DOM box -> scissor rect; IntersectionObserver culling
  models/
    types.ts         LampModel { object3D, leds: LedPlacement[], slots }
    source.ts        ModelSource: ProceduralSource | GltfSource
    h6022.ts         drum lathe + 132 LED placements (11 rows x 12 wrapped cols)
    h6056.ts         two bar extrusions + 48 LEDs each
    h6008.ts         bulb + socket, single emitter
  led-field.ts       (MotionSpec, t) -> Uint8ClampedArray  [no GL, pure]
  emission.ts        LED array -> DataTexture -> emissive material uniforms
  cast-light.ts      bloom + surface spill derived from the same texture
  controls.ts        orbit; hero only
  use-lamp-stage.ts  React shell hook (mirrors use-motion-stage.ts)
  LampStage.tsx      replaces DeviceStage at both call sites
```

**Reused unchanged:** `classify.ts`, `palette.ts`, `effect-playback.ts`,
`dominant-hsl.ts`, `components/stage/color.ts`. These already resolve
"what is this device doing" into a `MotionSpec` (archetype, palette, period,
intensity), which is exactly an LED evaluator's input.

**Deleted:** `components/stage/stage.tsx` (all hand-drawn instruments),
`motion-engine/canvas-renderer.ts`, `motion-engine/MotionCanvas.tsx`,
`motion-engine/use-motion-stage.ts`, `motion-engine/geometry.ts` (its normalized
2D bounds have no meaning in 3D). `motion-engine/geometry.test.ts` goes with it.

**Extended:** `driver.ts` gains a WebGL subscriber tier. It remains the only
`requestAnimationFrame` in the app.

### The load-bearing seam

```ts
// led-field.ts
export function evaluateLedField(
  spec: MotionSpec,
  layout: LedLayout,     // rows, cols, wrap — straight from capabilities
  t: number,             // absolute ticker seconds
  out: Uint8ClampedArray // rgb triples, length = leds * 3
): void;
```

Pure, GL-free, and unit-testable in the existing Node vitest environment. Every
archetype currently in `canvas-renderer.ts` (`blob`, `wave`, `plasma`, `chase`,
`sparkle`, `rain`, `breathe`, `strobe`, `gradient-drift`) becomes an entry here,
rewritten from "fill a 2D region" to "evaluate a color per LED index". Literal
effect playback (`effect-playback.ts`) writes into the same buffer.

This is the port's central simplification: an archetype stops painting pixels
and starts driving emitters, which is what the hardware does.

---

## The light simulation

Three layers, each derived from the one above.

### 1. LED field

`evaluateLedField` fills an `Uint8ClampedArray` once per frame per device. The
array is uploaded as a `DataTexture` (`cols x rows`, RGB, `NearestFilter`). One
texture per mounted device, reused across frames — no per-frame allocation.

For the H6022 the texture wraps in U (`wrapS = RepeatWrapping`) because column 11
physically touches column 0 on the drum. `matrix_wrap_col` from capabilities
drives that directly. For the H6056 the two bars sample two disjoint column
ranges of one 2x48 texture. The H6008 has no matrix, so its "field" is a single
color and the texture is 1x1.

### 2. Emission

The diffuser is a `MeshPhysicalMaterial` with:

- `emissiveMap` = the LED DataTexture, `emissiveIntensity` scaled by device
  brightness (the same `brightnessGlow` curve the current stage uses, so
  dimming behaves identically).
- `transmission` + `thickness` for the frosted shade, so an LED behind the
  diffuser blooms through it instead of appearing painted on the surface. This
  is what makes per-LED emission read as light inside an object rather than a
  texture.
- `roughness` / `metalness` per model slot: matte plastic shade, satin metal
  base, gloss bulb glass.

The LED positions are real geometry, so at low LED counts (the H6056's 48 per
bar) individual emitters are visible up close and blend at plate size — which is
what the physical bars do.

### 3. Cast light

Derived from the same texture, never authored separately:

- **Spill:** a ground plane and a soft backdrop receive light. Rather than
  running real shadow-casting lights per LED (132 lights is not viable), a small
  number of `PointLight`s (2-4 per device) sit at the LED field's centroids and
  are colored by the *mean* of their region's LEDs, recomputed each frame from
  the array we already have. Cheap, and it moves correctly when a chase runs
  around the drum.
- **Bloom:** selective bloom on the hero only, via a single bloom pass over the
  hero's scissor region. Plates skip post-processing entirely and lean on
  `emissiveIntensity` plus a cheap additive sprite halo — the same trick the
  current `Halo` component uses, kept because it is convincing at 200px and free.

### Off and dim

With `power === false` the LED texture is zeroed and only environment lighting
remains: the model reads as a real unlit object. This is the case the current
stage cannot express at all, and the main reason material realism was requested.

---

## Per-model geometry

Procedural, in TypeScript, behind `ModelSource` so a `.glb` can replace any model
later without touching the light simulation.

| Model | Body | LEDs |
|---|---|---|
| H6022 | Lathe: cylindrical drum shade on a tapered base; wrapped 12-column surface | 132, `row * 12 + col`, U wraps |
| H6056 | Two extruded bars with rounded caps on weighted feet | 2 x 48, one column range per bar |
| H6008 | Sphere-ish bulb envelope + threaded socket cylinder | 1 emitter, 1x1 texture |
| unknown | Neutral capsule | 1 emitter |

**Dimensions are proportional, not measured.** They come from the existing
layout's fixed-pixel bodies (documented in `geometry.ts`: the H6022 drum is
112x238, each H6056 tube 34x196, the H6008 bulb a 116px circle) plus product
photography. Real millimetre specs would refine them and are welcome later; this
spec does not claim accuracy it does not have.

---

## Integration and lifecycle

`LampStage` replaces `DeviceStage` at both call sites with a narrower prop set:

```ts
interface LampStageProps {
  state: DeviceState | DeviceSummary;
  variant?: "full" | "mini";   // hero | plate
  className?: string;
}
```

Mount: the hook registers a view (its DOM element + a per-device scene) with
`renderer.ts` and subscribes to `driver.ts` at tier `hero` or `plate`. Unmount:
deregister, dispose geometries/materials/textures owned by that view.

Each frame the shared renderer walks visible views, sets `scissor`/`viewport` to
each one's DOM box, and draws. Views scrolled out of the viewport are skipped
(`IntersectionObserver`). Geometry and materials are **cached per model**, not
per device — three H6056s on the dashboard share one bar geometry and one
material, with per-view LED textures and uniforms.

The canvas itself is a single fixed-position, `pointer-events: none` element
behind the app frame. Because the app frame is `h-dvh` with an inner
`overflow-y-auto` (a documented property of this layout), the canvas never needs
to track document scroll — only element boxes, which the views module reads each
frame.

---

## Rules inherited from the current stage

These are not optional and must be ported explicitly, not reimplemented by
assumption:

1. **Unknown means unknown.** When the ledger has no entry (`active.mode` is
   `unknown`), the lamp renders with zeroed LEDs and a neutral chassis: no
   color, no bloom, no motion. `stage.tsx` currently encodes this as
   `NEUTRAL_CHASSIS_HSL` and a null motion mode. Rendering a plausible guess
   here would recreate the bug `ledger.py` exists to prevent.
2. **A running scene outranks the live color fields.** `color` and
   `color_temp_k` read back stale during a scene/DIY/music mode. The LED field
   comes from the classified `MotionSpec` in those modes, never from the state
   fields.
3. **In basic mode, `basicHsl` decides.** A device in colour-temperature mode
   reports a placeholder white in `colorRgb` alongside the live
   `colorTemperatureK`; the temperature wins that pair. (Added 2026-08-25 — the
   defect that prompted this work.)
4. **The `UnknownModeChooser` overlay and the mode caption survive.**
   ("madisonnnn — DIY scene, assumed, 0s ago" and the reset affordance are
   honesty UI, not stage decoration.) They move out of `stage.tsx` into
   `LampStage`'s DOM layer, unchanged.
5. **No new cloud requests.** Everything here renders from state already polled.
   `request_meter` counts must be unchanged by this work.

---

## Performance budget

- **One** WebGL context, total.
- Hero: 60fps target, full material set, bloom pass.
- Plates: capped by `PLATE_CONCURRENCY_CAP` reinterpreted as a redraw budget —
  the 4 most recently visible plates animate; the rest hold their last frame and
  refresh at 4fps. Off-screen views do not draw.
- Shared geometry/material caches keyed by model.
- No per-frame allocation in `evaluateLedField` (the caller owns the buffer).
- Texture uploads are `cols x rows` (132 or 96 texels), not framebuffer-sized.

Measured before/after on a real iPhone Safari session against the full dashboard
grid, per the same discipline `driver.ts`'s cap was set with.

---

## Fallbacks and accessibility

The 2D path is deleted, so these are handled inside the 3D path:

- **No WebGL:** `LampStage` detects context creation failure once and renders a
  static CSS silhouette in the device's current color — a small, deliberate
  component, not the resurrected 1161-line stage.
- **`prefers-reduced-motion`:** the scene renders, materials and all, but the
  ticker is not subscribed. A single frame is drawn on mount and on state change.
  Rotation still works if the user drags.
- **Screen readers:** the canvas is `aria-hidden`, as today. State is conveyed by
  the existing readouts.

---

## Testing

| Layer | How |
|---|---|
| `led-field.ts` | vitest, Node env, pure. Golden arrays per archetype at fixed `t`; wrap correctness for the H6022 (col 11 adjacent to col 0); effect playback frames land on the right LED indices. |
| `models/*.ts` | vitest. LED placement count matches `matrix_rows * matrix_cols`; positions lie on the body surface; H6022 placements wrap continuously in U. |
| `views.ts` | vitest with stubbed DOM rects: scissor math, culling. |
| Honesty rules | vitest: `unknown` mode yields an all-zero LED field; a scene mode ignores `color`/`color_temp_k`; basic mode routes through `basicHsl`. |
| Render | `scripts/verify_ui.py` screenshots. WebGL in headless Chromium needs `--use-gl=swiftshader`; if that proves unreliable the render check becomes a manual gate and this spec says so rather than pretending it is automated. |
| Layout | `scripts/viewport_audit.py --check`. The stage occupies the same boxes; a moved box is a regression. |

---

## Migration

1. Land `led-field.ts` + model sources + tests with no UI wiring. Nothing renders
   yet; everything is verifiable.
2. Land `renderer.ts` / `views.ts` / `use-lamp-stage.ts` behind an unused
   `LampStage`.
3. Switch `page.tsx` (hero) to `LampStage`. Both stages exist for exactly this
   step.
4. Switch `device-plate.tsx` (plates).
5. Delete `stage.tsx`, `canvas-renderer.ts`, `MotionCanvas.tsx`,
   `use-motion-stage.ts`, `geometry.ts` and their tests. Port the caption and
   `UnknownModeChooser` before this step, not during it.

Each step is independently revertible; step 5 is the point of no return and
happens only after 3 and 4 are confirmed on real hardware.

## Risks

- **Bundle size.** three.js is the single largest dependency this app would gain.
  Mitigated by importing narrow entry points and avoiding drei entirely;
  measured against the current build at step 2 and reported.
- **Mobile GPU cost.** `transmission` on `MeshPhysicalMaterial` is expensive (it
  renders a transmission pass). If it proves too slow on the phone, plates drop
  to `MeshStandardMaterial` with emissive only and the hero keeps transmission.
  This is a documented fallback, not a discovery to make later.
- **Headless WebGL.** May weaken the automated screenshot gate; see Testing.
- **Deleting the 2D path** removes the only renderer known to work everywhere.
  Chosen deliberately by the user on 2026-08-25, with the no-WebGL static
  fallback as the safety net.
