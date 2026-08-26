/**
 * Spill and bloom, derived from the same LED buffer `emission.ts` uploads —
 * never authored separately, per the design doc's "the cast light falls out
 * of the emission" goal. Two things live here:
 *
 * 1. **Spill lights** — a handful of real `THREE.PointLight`s, one per
 *    `SpillCluster` (`models/types.ts`), coloured each frame by the mean of
 *    their own LED indices. Cheap compared to per-LED shadow casting (132
 *    lights is not viable, per the design doc), and it still sweeps
 *    correctly when a chase runs around the drum because the clusters
 *    partition the matrix spatially rather than being fixed art-directed
 *    colours.
 * 2. **The additive sprite halo** — the cheap trick `components/stage/stage.tsx`'s
 *    `Halo` component already uses at plate size, ported to a `THREE.Sprite`
 *    with additive blending so it sits *behind* the model and reads as
 *    ambient bloom without a post-processing pass.
 *
 * **Hero bloom (design doc decision 7) is not implemented in this pass.**
 * The doc's own escape hatch — "if that fights the shared canvas, fall back
 * to the additive sprite halo for BOTH tiers, and say so" — is taken
 * deliberately rather than by default: a `WebGLRenderTarget` + `EffectComposer`
 * pass scoped to only the hero's scissor rect, on a renderer that every other
 * view is also scissoring into on the same frame, has real failure modes
 * (the composer's own viewport/scissor bookkeeping, render-target sizing on
 * hero resize, restoring the main renderer's state for the next view) that
 * cannot be told apart from "working" without a live GL browser pass, which
 * is outside this task's verification (`npm run typecheck`/`lint`/`test`
 * only — the render itself is `scripts/verify_ui.py`'s job per the design
 * doc's Testing table). Shipping an unverified composer integration risks a
 * silently broken hero with no test able to catch it. The additive sprite
 * halo below is used for both tiers instead, and is a real, working effect
 * at both sizes today — not a placeholder.
 */

import { AdditiveBlending, DataTexture, PointLight, RGBAFormat, Sprite, SpriteMaterial, UnsignedByteType, LinearFilter } from "three";
import type { LampModel, SpillCluster } from "./models/types";

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Mean colour of `indices` into `buffer` (an LED RGB buffer, `leds * 3`
 * bytes — the same shape `led-field.ts` produces and `emission.ts` uploads).
 * `[0, 0, 0]` for an empty cluster rather than `NaN`, since a `SpillCluster`
 * with no LEDs would otherwise poison every light it drives.
 *
 * Allocates nothing per call beyond the returned 3-tuple: `indices` is
 * `SpillCluster.ledIndices`, built once per model at construction time
 * (`models/h6022.ts`/`h6056.ts`'s `buildSpill`), not rebuilt here.
 */
export function meanLedColor(buffer: Uint8ClampedArray, indices: readonly number[]): readonly [number, number, number] {
  if (indices.length === 0) return [0, 0, 0];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const idx of indices) {
    const offset = idx * 3;
    r += buffer[offset] ?? 0;
    g += buffer[offset + 1] ?? 0;
    b += buffer[offset + 2] ?? 0;
  }
  const n = indices.length;
  return [r / n, g / n, b / n];
}

/** Mean colour across every LED in the buffer — the halo's colour source.
 *  Unlike `meanLedColor`, this needs no index list: it walks the buffer
 *  directly, so lighting the halo from "the whole device" rather than one
 *  cluster costs no extra allocation either. */
export function meanAllLedColor(buffer: Uint8ClampedArray): readonly [number, number, number] {
  const ledCount = buffer.length / 3;
  if (ledCount === 0) return [0, 0, 0];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < buffer.length; i += 3) {
    r += buffer[i] ?? 0;
    g += buffer[i + 1] ?? 0;
    b += buffer[i + 2] ?? 0;
  }
  return [r / ledCount, g / ledCount, b / ledCount];
}

/** How far a spill light's influence reaches, relative to the model's own
 *  size — proportional rather than a fixed world-unit distance, so a plate's
 *  small model and the hero's larger one both get a light that falls off
 *  believably against their own scale. `decay = 2` is physically-correct
 *  inverse-square falloff, matching how `RoomEnvironment`'s own lights in
 *  `renderer.ts`'s shared PMREM are set up. */
/**
 * The layer the spill lights live on, and which only the surfaces that
 * legitimately receive cast light (the ground, the halo backdrop) join. See
 * `createSpillLights` for why the lamp body is deliberately excluded.
 */
export const SPILL_LIGHT_LAYER = 1;

const SPILL_LIGHT_DISTANCE_FACTOR = 3;
const SPILL_LIGHT_DECAY = 2;

/** Scales mean-luma-times-brightness into a `PointLight.intensity` that
 *  reads as "this LED region is casting light" without blowing out the
 *  ground plane at full brightness — tuned by eye against the design doc's
 *  "convincing render, not a luminaire simulation" non-goal; there is no
 *  measured lumen value to derive this from. */
/**
 * three's lights are physical since r155: a `PointLight`'s intensity is candela
 * and falls off with the square of distance (`decay = 2`). A mean LED luma is a
 * small fraction of 1, so the original 2.4 put roughly a quarter-candela a few
 * world units from the ground and cast nothing a person could see — the design
 * doc's "the cast light falls out of the emission" was true in the code and
 * invisible on screen. This is the conversion from a 0..1 luma to a candela
 * value that actually reaches the floor, not a brightness preference.
 */
const SPILL_INTENSITY_SCALE = 22;

/** One `PointLight` per `SpillCluster`, positioned at that cluster's own
 *  centroid (already computed once per model in `models/h6022.ts`/`h6056.ts`).
 *  Intensity starts at zero; `updateSpillLights` sets the real value every
 *  frame the view draws, so a light that never gets updated (a view that
 *  never becomes visible) simply contributes nothing rather than glowing an
 *  arbitrary default colour. */
export function createSpillLights(model: LampModel): PointLight[] {
  return model.spill.map((cluster: SpillCluster) => {
    const light = new PointLight(0xffffff, 0, model.fitRadius * SPILL_LIGHT_DISTANCE_FACTOR, SPILL_LIGHT_DECAY);
    light.position.set(cluster.position[0], cluster.position[1], cluster.position[2]);
    // The lamp must not be re-lit by the light it is casting. A cluster
    // centroid is the mean of its LEDs' positions, and averaging twelve
    // columns around a drum lands on the cylinder's AXIS — so these lights sit
    // INSIDE the shade, and through a transmissive material they washed it a
    // flat, uniform colour that swamped the emissive map completely: a chase
    // with nine of twelve columns dark rendered as an evenly lit pink drum.
    // three filters lighting per object with `object.layers.test(light.layers)`,
    // so putting the spill on its own layer means it reaches the surfaces that
    // should catch the glow and nothing else. The body's only light source is
    // its own emission, which is the whole claim the design makes.
    light.layers.set(SPILL_LIGHT_LAYER);
    return light;
  });
}

/**
 * Recolours and re-intensifies every spill light from the LED buffer that
 * already exists this frame — no separate "what colour should the spill be"
 * authoring, per this module's own file-level rule. `lights` and
 * `model.spill` are the same length and in the same order (`createSpillLights`
 * built `lights` directly from `model.spill`), so they're walked in lockstep
 * by index rather than by any shared key.
 *
 * `brightnessFactor` is `emission.ts`'s `brightnessGlow(brightness)` (already
 * zero when the device is off, via the caller passing `0` rather than this
 * function re-deriving power state) — the same curve the diffuser's own
 * `emissiveIntensity` uses, so the cast light dims in lockstep with the
 * object casting it instead of visually decoupling from it.
 */
export function updateSpillLights(
  lights: readonly PointLight[],
  model: LampModel,
  buffer: Uint8ClampedArray,
  brightnessFactor: number,
): void {
  for (let i = 0; i < lights.length; i++) {
    const light = lights[i];
    const cluster = model.spill[i];
    if (!light || !cluster) continue;
    const [r, g, b] = meanLedColor(buffer, cluster.ledIndices);
    light.color.setRGB(r / 255, g / 255, b / 255);
    const meanLuma = (r + g + b) / (3 * 255);
    light.intensity = meanLuma * brightnessFactor * SPILL_INTENSITY_SCALE;
  }
}

/** Texel resolution of the shared halo/ground falloff texture. Small on
 *  purpose: it is sampled through a soft, heavily minified sprite/plane, so
 *  a larger texture would cost upload bandwidth for detail nothing ever
 *  resolves. */
const RADIAL_TEXTURE_SIZE = 64;

let sharedRadialTexture: DataTexture | null = null;

/**
 * A soft white-to-transparent radial falloff, built once and shared by the
 * halo sprite here and the ground plane's `alphaMap` in `renderer.ts` — the
 * same "soft blurred radial gradient" shape the old CSS `Halo` component
 * built from a browser radial-gradient, reproduced as texel data instead
 * since there is no canvas 2D context to draw one with here. Reusing one
 * texture for both purposes is deliberate: they are the same falloff, drawn
 * at two different scales and colours, not two different effects that only
 * coincidentally look similar.
 */
export function getRadialFalloffTexture(): DataTexture {
  if (sharedRadialTexture) return sharedRadialTexture;

  const size = RADIAL_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const falloff = clamp01(1 - dist);
      const alpha = falloff * falloff; // squared: a softer, more concentrated core than a linear ramp
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  sharedRadialTexture = texture;
  return texture;
}

/** Test-only reset for `getRadialFalloffTexture`'s module-level cache, so
 *  `cast-light.test.ts` can assert the builder actually runs rather than
 *  observing a texture a previous test case already created. Production
 *  code never calls this — see `renderer.ts`'s own note on why the shared
 *  halo/ground assets are intentionally never torn down at runtime. */
export const castLightTestHooks = {
  resetRadialTexture(): void {
    sharedRadialTexture = null;
  },
};

/** Halo scale relative to the model's own bounding radius — large enough to
 *  read as ambient bloom around the object, not a tight ring hugging it. */
const HALO_SCALE_FACTOR = 2.2;

/** Caps how opaque the halo can get at full brightness — additive blending
 *  stacks with whatever bloom the diffuser's own emission already
 *  contributes, so this is deliberately held below 1 to avoid the halo
 *  alone washing out a light-coloured device. */
const HALO_OPACITY_SCALE = 0.85;

/**
 * Builds one view's halo sprite. Not shared across views the way model
 * geometry is (`models/source.ts`): the sprite's colour and opacity are
 * per-device, so each view needs its own `SpriteMaterial` instance even
 * though every instance samples the one shared `getRadialFalloffTexture()`.
 */
export function createHalo(model: LampModel): Sprite {
  const material = new SpriteMaterial({
    map: getRadialFalloffTexture(),
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    opacity: 0,
  });
  const sprite = new Sprite(material);
  sprite.position.set(0, model.height * 0.5, 0);
  sprite.scale.setScalar(model.fitRadius * HALO_SCALE_FACTOR);
  return sprite;
}

/** Recolours and re-intensifies `halo` from the LED buffer's overall mean —
 *  see `meanAllLedColor`. `brightnessFactor` carries the same meaning as in
 *  `updateSpillLights`: already zero when the device is off. */
export function updateHalo(halo: Sprite, meanColor: readonly [number, number, number], brightnessFactor: number): void {
  const [r, g, b] = meanColor;
  halo.material.color.setRGB(r / 255, g / 255, b / 255);
  const luma = (r + g + b) / (3 * 255);
  halo.material.opacity = clamp01(luma * brightnessFactor * HALO_OPACITY_SCALE);
}
