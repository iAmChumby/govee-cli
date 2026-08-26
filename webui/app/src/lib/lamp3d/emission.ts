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
 * Lowered from 0.22 once `frameNormalizeGain` landed. The two compound: the
 * scatter pulls every texel toward the frame MEAN, which for a multi-hue scene
 * is close to neutral, and the gain then lifts that desaturated result to full
 * peak. Together at 0.22 they rendered a rainbow DIY scene as the pastel wash
 * the design doc exists to eliminate. At 0.14 the shade still reads as frosted
 * plastic rather than a bank of bare emitters, and the hues survive.
 *
 * This is a presentation model of the plastic, not a claim about the device.
 * The LED buffer itself is never altered — `led-field.ts`'s output stays
 * exactly what the archetype computed, and this mix happens on the way to the
 * GPU. Deliberately kept low: at 0.14 the per-emitter structure the whole
 * design exists to show still dominates. An all-zero frame has an all-zero
 * mean, so a powered-off lamp stays completely dark.
 */
const SHADE_SCATTER = 0.14;

/**
 * Ceiling on `frameNormalizeGain`'s lift. See that function for the argument;
 * this is the part of it that is a judgement call rather than a derivation.
 *
 * Uncapped normalization would drive ANY non-black frame to full peak,
 * including one that is dim because the pattern itself is dim — the tail of a
 * fade, the trough of a breathe. Those are real, and flattening them would be
 * its own kind of lie. 4x lifts a mid-dark colour to full (a peak channel of
 * 64/255 or above normalizes completely) while leaving a genuinely dark frame
 * genuinely dark, so a fade still visibly fades.
 */
const EMISSION_NORMALIZE_MAX_GAIN = 4;

/**
 * The exposure this frame is lifted by before it reaches the GPU — the fix
 * for "the models don't emit their light colors at all", and the one piece of
 * this module that is a presentation model rather than a measurement.
 *
 * **Why a lift is honest here.** Govee reports a device's colour and its
 * brightness as two SEPARATE fields: `colorRgb` carries the hue the user
 * picked, `brightness` carries how bright the lamp is driving it. A lamp set
 * to `#330066` at 100% is not dim — it is a bright purple. Feeding that hex
 * straight into emissive radiance multiplies the two together and
 * double-counts the darkness, so the render showed a near-unlit body for a
 * lamp that is, in the room, plainly glowing. That is the same class of error
 * as reporting 2700K for a lamp running a blue scene: reproducing the number
 * while misrepresenting the thing.
 *
 * **What is preserved, exactly.** The gain is a single scalar applied to
 * every channel of every LED equally, so:
 *  - **Hue is preserved exactly** — scaling `(r, g, b)` by `k` leaves every
 *    channel ratio unchanged.
 *  - **Saturation is preserved exactly** — HSV saturation is
 *    `(max - min) / max`, and both terms scale by `k`.
 *  - **Every relative relationship WITHIN the frame is preserved exactly** —
 *    which is why the peak is taken across the whole frame rather than
 *    per-LED. A per-LED normalization would drive a chase's dim tail to the
 *    same peak as its bright head and erase the pattern the archetype
 *    computed. Only the frame's overall exposure changes.
 *
 * **What still carries luminance.** `brightnessGlow(brightness)` alone, via
 * `emissiveIntensity` — so dimming the device still visibly dims the render,
 * monotonically, which is the property that makes the brightness control
 * mean something.
 *
 * An all-zero frame returns gain 1 and stays all-zero: a powered-off lamp, or
 * one whose ledger mode is `unknown`, renders completely dark. That invariant
 * is load-bearing (CLAUDE.md's first rule) and is covered by a test.
 */
export function frameNormalizeGain(buffer: Uint8ClampedArray): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i];
    if (v > peak) peak = v;
  }
  // Identity rather than zero for a black frame: every channel is already 0,
  // so the gain cannot change the result, and 1 keeps this a plain "exposure
  // multiplier" everywhere it is read.
  if (peak <= 0) return 1;
  return Math.min(255 / peak, EMISSION_NORMALIZE_MAX_GAIN);
}

/**
 * Returns the gain it applied, so the caller can drive the cast light and
 * the halo at the same exposure as the body — see `applyEmission`.
 *
 * `normalizeExposure` exists for exactly one case: a palette the resolver
 * marked INDETERMINATE. Normalization is justified by colour and brightness
 * being separate device fields — a lamp set to `#330066` at 100% is a bright
 * purple, so its frame's peak has to be lifted or the render reads as grey.
 * That argument needs a hue to preserve. The indeterminate palette has none;
 * it is deliberately neutral grey precisely so it asserts nothing, and
 * lifting its peak to 255 turns it into a *bright white lamp* — a state this
 * hardware really can be in, so the render stops saying "unknown" and starts
 * claiming "white". Passing false leaves it dim and colourless, which is the
 * only honest picture of a scene nobody has verified.
 */
export function uploadLedFrame(ledTex: LedTexture, normalizeExposure = true): number {
  const { buffer, texels } = ledTex;
  const count = buffer.length / 3;
  if (count === 0) return 1;

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
  // One scalar for the whole frame, so the scatter blend below still mixes
  // like-for-like — gaining the texel and its frame mean by the same factor
  // leaves the blend's proportions untouched.
  const gain = normalizeExposure ? frameNormalizeGain(buffer) : 1;

  for (let i = 0; i < count; i++) {
    const src = i * 3;
    const dst = i * 4;
    // `texels` is a Uint8ClampedArray, so the write itself clamps to 0..255 —
    // which is exactly the wanted behaviour at the frame's peak, where the
    // gain lands on 255 by construction and rounding can only push it a
    // fraction over.
    texels[dst] = (buffer[src] * keep + meanR * SHADE_SCATTER) * gain;
    texels[dst + 1] = (buffer[src + 1] * keep + meanG * SHADE_SCATTER) * gain;
    texels[dst + 2] = (buffer[src + 2] * keep + meanB * SHADE_SCATTER) * gain;
  }
  ledTex.texture.needsUpdate = true;
  return gain;
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
 *
 * Retuned from 2.6 to 1.75 when `frameNormalizeGain` was added, because the two
 * multiply. Before normalization this gain was compensating for raw device
 * colours that were often dark; now the frame arrives already lifted to full
 * peak, so the old value drove every bright texel deep into the roll-off, where
 * ACES desaturates toward white — the render went from too dark to washed out,
 * which is the same failure from the other side. 1.75 keeps a full-brightness
 * emitter clearly the brightest thing in the frame while leaving it its hue.
 */
const EMISSIVE_GAIN = 1.75;

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
export function applyEmission(
  model: LampModel,
  ledTex: LedTexture,
  power: boolean,
  brightness: number | null,
  normalizeExposure = true,
): number {
  if (!power) {
    clearLedField(ledTex.buffer);
  }
  const gain = uploadLedFrame(ledTex, normalizeExposure);

  const diffuser = model.slots.diffuser;
  if (!(diffuser instanceof MeshPhysicalMaterial)) return gain;

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
  // The caller drives the spill lights and the halo at this same exposure, so
  // the light the lamp throws matches the light it appears to be making.
  // Returning it beats recomputing it in cast-light.ts: one frame, one gain.
  return gain;
}
