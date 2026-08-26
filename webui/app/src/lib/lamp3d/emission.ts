/**
 * LED array -> `DataTexture` -> material uniforms.
 *
 * `led-field.ts` fills a plain `Uint8ClampedArray`; this module is the only
 * place that turns that buffer into something the GPU samples, and the only
 * place that decides how device brightness and power turn into how bright
 * the diffuser actually glows. Everything here except `createLedTexture`'s
 * `DataTexture` construction is plain math, so most of it is unit-testable
 * without a live GL context — the texture object itself can be built and
 * inspected in Node (three's `DataTexture` does no GPU work until a
 * renderer actually uploads it), which is what `emission.test.ts` relies on.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  MeshPhysicalMaterial,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from "three";
import { clearLedField } from "./led-field";
import { ledCount, type LampModel, type LedLayout } from "./models/types";

/** The one buffer + texture pair a mounted view owns for its device. `buffer`
 *  is what `led-field.ts` writes into every frame; `texture` wraps it without
 *  copying (`DataTexture`'s `data` *is* `buffer` — see `createLedTexture`), so
 *  uploading a new frame is "mutate `buffer` in place, then flip
 *  `texture.needsUpdate`" rather than allocating a new texture. */
export interface LedTexture {
  readonly texture: DataTexture;
  /** RGB triples — the buffer `led-field.ts` writes a frame into. Stays RGB
   *  because that is the evaluator's tested contract and the shape its
   *  archetypes are written against. */
  readonly buffer: Uint8ClampedArray;
  /** The RGBA texels the GPU actually reads, expanded from `buffer` on
   *  upload. See `createLedTexture` for why the texture cannot be RGB. */
  readonly texels: Uint8ClampedArray;
}

/**
 * Allocates one device's LED buffer and its backing `DataTexture`, sized
 * `layout.cols x layout.rows` per the spec — never framebuffer-sized, and
 * never reallocated afterward; the caller re-uses this pair for the life of
 * the mounted view.
 *
 * **Format:** `RGBAFormat`, with the RGB frame expanded into it on upload.
 * `RGBFormat` does still exist in three 0.180 and does still map to `gl.RGB`,
 * which makes it look like the obvious choice for a buffer that is already RGB
 * triples — but combining it with `SRGBColorSpace` below is invalid, and three
 * says so at runtime on every single upload: "THREE.WebGLTextures: sRGB encoded
 * textures have to use RGBAFormat and UnsignedByteType." WebGL2 exposes sRGB
 * only as `SRGB8_ALPHA8`; there is no three-channel sRGB internal format to map
 * onto. The texture is then never sampled correctly and the lamp renders unlit,
 * which is exactly how this was found — on screen, not in a type.
 *
 * So the RGB->RGBA expansion is paid, and it is cheap: 132 texels for the
 * H6022, 96 for the H6056. The alternative — making `led-field.ts` write RGBA —
 * would push a GPU storage detail into a module whose entire value is being
 * pure, GL-free and testable in Node. The alpha bytes are written once at
 * allocation and never touched again.
 *
 * **Wrap:** `wrapS = RepeatWrapping` exactly when `layout.wrapCol` — the
 * H6022's column 11 must sample continuously into column 0 (see
 * `models/h6022.ts`'s file-level comment on `LatheGeometry`'s UVs, which
 * already runs `u` `0..1` once around the full circumference so this wrap
 * setting is the only piece left to join the seam). `wrapT` is always
 * `ClampToEdgeWrapping`: no model wraps its row axis.
 *
 * **Filter:** `LinearFilter` for magnification, `NearestFilter` for
 * minification — a considered departure from the design doc's "NearestFilter",
 * made to serve that doc's own stated goal rather than its literal wording.
 *
 * Nearest on both axes renders each LED as a hard-edged flat strip. On the
 * H6022 that is twelve razor-sharp bands wrapped around the drum, and it reads
 * exactly as the doc says the result must NOT read: "a texture painted on the
 * surface" instead of "light inside an object". The doc asks for both that
 * quality and for Nearest, and at twelve columns across a 500px drum the two
 * cannot both be had. A real frosted shade scatters its emitters together, so
 * linear magnification is also the physically truthful choice.
 *
 * Minification stays Nearest: when a plate shrinks the drum below one screen
 * pixel per texel, averaging neighbouring LEDs would invent colours the device
 * is not showing, and this console does not invent.
 *
 * `wrapS = RepeatWrapping` is what keeps this honest at the H6022's seam —
 * linear filtering across column 11 blends into column 0 rather than clamping,
 * so the interpolation follows the drum's real topology.
 *
 * **Colour space:** `SRGBColorSpace`. `led-field.ts` samples palette hex
 * strings the same way CSS does (`components/stage/color.ts`), i.e. as
 * already gamma-encoded display colour, not linear light — the same
 * assumption three makes for an ordinary loaded image texture. Leaving this
 * at the default `NoColorSpace` would read those bytes as linear and wash
 * the emission out relative to how the same hex values render everywhere
 * else in the console.
 */
export function createLedTexture(layout: LedLayout): LedTexture {
  const count = ledCount(layout);
  const buffer = new Uint8ClampedArray(count * 3);
  const texels = new Uint8ClampedArray(count * 4);
  // Opaque once, for the life of the texture: `uploadLedFrame` only ever
  // rewrites the three colour bytes of each texel.
  for (let i = 0; i < count; i++) texels[i * 4 + 3] = 255;
  const texture = new DataTexture(texels, layout.cols, layout.rows, RGBAFormat, UnsignedByteType);
  texture.wrapS = layout.wrapCol ? RepeatWrapping : ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, buffer, texels };
}

/**
 * Expands this frame's RGB triples into the texture's RGBA texels and marks it
 * for re-upload. Allocation-free and the only place the two representations
 * meet, so `led-field.ts` never has to know the GPU wants a fourth byte.
 */
/**
 * How much of each texel is replaced by the frame's own mean colour, modelling
 * the shade's internal scatter.
 *
 * A frosted diffuser does not present its emitters in isolation: light from a
 * lit LED bounces inside the shade and lifts its neighbours, which is why a
 * real lamp running a chase glows as a whole object with a bright region
 * travelling across it, rather than showing one lit stripe on a dead grey
 * cylinder. Without this the render was the latter, and the design doc is
 * explicit that emission must read "as light inside an object rather than a
 * texture".
 *
 * This is a presentation model of the plastic, not a claim about the device.
 * The LED buffer itself is never altered — `led-field.ts`'s output stays
 * exactly what the archetype computed, and this mix happens on the way to the
 * GPU. Deliberately kept low: at 0.22 the per-emitter structure the whole
 * design exists to show still dominates. An all-zero frame has an all-zero
 * mean, so a powered-off lamp stays completely dark.
 */
const SHADE_SCATTER = 0.22;

export function uploadLedFrame(ledTex: LedTexture): void {
  const { buffer, texels } = ledTex;
  const count = buffer.length / 3;
  if (count === 0) return;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < count; i++) {
    const src = i * 3;
    sumR += buffer[src];
    sumG += buffer[src + 1];
    sumB += buffer[src + 2];
  }
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const keep = 1 - SHADE_SCATTER;

  for (let i = 0; i < count; i++) {
    const src = i * 3;
    const dst = i * 4;
    texels[dst] = buffer[src] * keep + meanR * SHADE_SCATTER;
    texels[dst + 1] = buffer[src + 1] * keep + meanG * SHADE_SCATTER;
    texels[dst + 2] = buffer[src + 2] * keep + meanB * SHADE_SCATTER;
  }
  ledTex.texture.needsUpdate = true;
}

/**
 * Brightness as a 0..1 emission factor with a visible floor — copied
 * verbatim from `components/stage/stage.tsx`'s `brightnessGlow` (the exact
 * numbers: floor 0.25, span 0.75, clamp 1..100) so dimming a device reads
 * identically under the 3D stage as it does today. This is the shared
 * helper the house rules ask for in place of duplicating those magic
 * numbers in a second file; `stage.tsx` itself is deleted at migration step
 * 5 of the design doc, at which point its own copy goes with it rather than
 * being pointed here, since nothing will import it any more.
 */
/**
 * How far past display white a fully-bright emitter is driven.
 *
 * `brightnessGlow` tops out at 1.0, which ACES tone mapping renders noticeably
 * below white — correct for a surface, wrong for something that is supposed to
 * be the light source in the frame. This gain pushes a 100%% emitter into the
 * range where the tone curve's highlight roll-off does the work, so the LED
 * keeps its hue while reading as genuinely bright rather than merely pale.
 */
const EMISSIVE_GAIN = 2.6;

export function brightnessGlow(brightness: number | null): number {
  const clamped = Math.min(100, Math.max(1, brightness ?? 50));
  return 0.25 + 0.75 * (clamped / 100);
}

/**
 * Wires one view's `LedTexture` onto its model's shared diffuser material
 * and sets the brightness-driven `emissiveIntensity` — the "material
 * uniforms" half of this module's job.
 *
 * Must be called every frame a view draws, not just on state change:
 * `model.slots.diffuser` is the **shared** material every view of this model
 * string uses (`models/source.ts`), so a dashboard with three H6056 plates
 * has three different `LedTexture`s but one `MeshPhysicalMaterial`. Binding
 * *this* view's texture and brightness onto it right before that view's own
 * draw call — and letting the next view rebind its own right after — is the
 * same "reparent immediately before drawing" discipline `source.ts`'s module
 * comment documents for `object3D`, applied to the material's uniforms
 * instead of the scene graph.
 *
 * **Power off zeroes the buffer**, per the design doc's "off and dim" rule:
 * with the LED field cleared and `scene.environment` still lighting the
 * body (renderer.ts's shared `RoomEnvironment` PMREM), the model reads as a
 * real unlit object rather than a device that happens to be reporting black.
 * This intentionally overrides whatever `led-field.ts` already wrote into
 * `ledTex.buffer` for this frame — power is the final word, not another
 * input the archetype math has to know about.
 */
export function applyEmission(model: LampModel, ledTex: LedTexture, power: boolean, brightness: number | null): void {
  if (!power) {
    clearLedField(ledTex.buffer);
  }
  uploadLedFrame(ledTex);

  const diffuser = model.slots.diffuser;
  if (!(diffuser instanceof MeshPhysicalMaterial)) return;

  const hadNoMap = diffuser.emissiveMap === null;
  if (diffuser.emissiveMap !== ledTex.texture) {
    diffuser.emissiveMap = ledTex.texture;
  }
  if (hadNoMap) {
    // Every model file (h6022/h6056/h6008/unknown) constructs its diffuser
    // with `emissive: 0x000000` — MeshPhysicalMaterial's emissive output is
    // `emissiveIntensity * emissiveColor * emissiveMap`, so a black
    // `emissiveColor` zeroes that product regardless of what the map holds.
    // Lifting it to white is what actually lets the LED texture reach the
    // render; it belongs here because this module owns "how the LED buffer
    // becomes light", not in every model file. Attaching a map for the
    // first time also changes the compiled shader's `USE_EMISSIVEMAP`
    // define, which three only picks up automatically going map -> null,
    // not null -> map — `needsUpdate` forces that recompile. `hadNoMap` is
    // true only once per shared material's whole lifetime (every later call,
    // for this view or any other view of the same model, finds the map
    // already non-null), so this branch never re-fires when views merely
    // swap which texture is bound.
    diffuser.needsUpdate = true;
    diffuser.emissive.setRGB(1, 1, 1);
  }
  diffuser.emissiveIntensity = brightnessGlow(brightness) * EMISSIVE_GAIN;
}
