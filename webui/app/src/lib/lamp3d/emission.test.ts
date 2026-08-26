/**
 * Tests for `emission.ts`. Runs in the default Node vitest environment:
 * constructing a `THREE.DataTexture` or `MeshPhysicalMaterial` does no GPU
 * work by itself (only an actual `WebGLRenderer` upload does), so the parts
 * of this module that don't need a live GL context are fully exercisable
 * here — same rationale `models.test.ts` documents for testing procedural
 * geometry without jsdom.
 */

import { describe, expect, it } from "vitest";
import { ClampToEdgeWrapping, MeshPhysicalMaterial, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from "three";
import { applyEmission, brightnessGlow, createLedTexture, uploadLedFrame } from "./emission";
import { ledCount, type LampModel, type LedLayout } from "./models/types";

const WRAPPED: LedLayout = { rows: 11, cols: 12, wrapCol: true };
const UNWRAPPED: LedLayout = { rows: 2, cols: 48, wrapCol: false };

describe("brightnessGlow", () => {
  it("matches stage.tsx's curve exactly: floor 0.25, span 0.75, clamp 1..100", () => {
    expect(brightnessGlow(1)).toBeCloseTo(0.25 + 0.75 * (1 / 100));
    expect(brightnessGlow(100)).toBeCloseTo(1);
    expect(brightnessGlow(50)).toBeCloseTo(0.25 + 0.75 * 0.5);
  });

  it("clamps below 1 and above 100 rather than extrapolating", () => {
    expect(brightnessGlow(0)).toBe(brightnessGlow(1));
    expect(brightnessGlow(-50)).toBe(brightnessGlow(1));
    expect(brightnessGlow(500)).toBe(brightnessGlow(100));
  });

  it("defaults null to 50 — the same default stage.tsx's curve uses", () => {
    expect(brightnessGlow(null)).toBeCloseTo(brightnessGlow(50));
  });
});

describe("createLedTexture", () => {
  it("sizes the texture cols x rows and the buffer leds * 3", () => {
    const { texture, buffer } = createLedTexture(WRAPPED);
    expect(texture.image.width).toBe(12);
    expect(texture.image.height).toBe(11);
    expect(buffer.length).toBe(ledCount(WRAPPED) * 3);
  });

  it("backs the texture's image data with the same texel array every frame — no reallocation", () => {
    const { texture, texels } = createLedTexture(UNWRAPPED);
    expect(texture.image.data).toBe(texels);
  });

  /**
   * The regression this exists for: the texture was `RGBFormat` while its
   * colour space was `SRGBColorSpace`, which WebGL2 cannot express — it only
   * offers sRGB as `SRGB8_ALPHA8`. three rejected it on every upload with
   * "sRGB encoded textures have to use RGBAFormat and UnsignedByteType" and
   * the lamp rendered unlit. Nothing in a type or a unit test caught it; it
   * was found by looking at the screen.
   */
  it("is RGBA, because sRGB has no three-channel format to map onto", () => {
    const { texture } = createLedTexture(WRAPPED);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(UnsignedByteType);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
  });

  it("allocates four bytes per LED and starts every texel opaque", () => {
    const { texels } = createLedTexture(WRAPPED);
    expect(texels.length).toBe(ledCount(WRAPPED) * 4);
    for (let i = 0; i < ledCount(WRAPPED); i++) {
      expect(texels[i * 4 + 3]).toBe(255);
    }
  });

  it("uploadLedFrame keeps alpha opaque and leaves a uniform frame untouched", () => {
    const led = createLedTexture(UNWRAPPED);
    led.buffer.fill(120);
    const versionBefore = led.texture.version;

    uploadLedFrame(led);

    // Every LED equals the frame mean, so the shade-scatter mix has nothing to
    // move: a flat frame must survive the trip byte for byte.
    const count = led.buffer.length / 3;
    for (let i = 0; i < count; i++) {
      expect(led.texels[i * 4]).toBe(120);
      expect(led.texels[i * 4 + 1]).toBe(120);
      expect(led.texels[i * 4 + 2]).toBe(120);
      expect(led.texels[i * 4 + 3]).toBe(255);
    }
    expect(led.texture.version).toBeGreaterThan(versionBefore);
  });

  it("uploadLedFrame mixes each texel toward the frame mean, without reordering", () => {
    const led = createLedTexture(UNWRAPPED);
    const count = led.buffer.length / 3;
    // Half the LEDs black, half full red — mean red is 127.5.
    for (let i = 0; i < count; i++) led.buffer[i * 3] = i < count / 2 ? 0 : 255;

    uploadLedFrame(led);

    const dark = led.texels[0];
    const lit = led.texels[(count - 1) * 4];
    // Both pulled toward the mean, neither all the way: the per-emitter
    // structure the design exists to show has to survive the scatter.
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(64);
    expect(lit).toBeLessThan(255);
    expect(lit).toBeGreaterThan(191);
    expect(lit).toBeGreaterThan(dark);
    // Symmetric about the mean, so scatter cannot shift the frame's overall level.
    expect((dark + lit) / 2).toBeCloseTo(127.5, 0);
  });

  it("uploadLedFrame leaves an all-zero frame completely black — the power-off rule", () => {
    const led = createLedTexture(WRAPPED);
    led.buffer.fill(0);
    uploadLedFrame(led);
    const count = led.buffer.length / 3;
    for (let i = 0; i < count; i++) {
      expect(led.texels[i * 4]).toBe(0);
      expect(led.texels[i * 4 + 1]).toBe(0);
      expect(led.texels[i * 4 + 2]).toBe(0);
    }
  });

  it("wraps S exactly when the layout wraps (the H6022 drum seam)", () => {
    expect(createLedTexture(WRAPPED).texture.wrapS).toBe(RepeatWrapping);
    expect(createLedTexture(UNWRAPPED).texture.wrapS).toBe(ClampToEdgeWrapping);
  });

  it("never wraps T — no model wraps its row axis", () => {
    expect(createLedTexture(WRAPPED).texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(createLedTexture(UNWRAPPED).texture.wrapT).toBe(ClampToEdgeWrapping);
  });
});

/** A minimal `LampModel` stand-in — only `slots.diffuser` matters to
 *  `applyEmission`, so the rest is filled with cheap placeholders rather
 *  than pulling in a real procedural body. */
function fakeModel(diffuser: MeshPhysicalMaterial): LampModel {
  return {
    model: "TEST",
    object3D: undefined as never,
    leds: [],
    layout: UNWRAPPED,
    diffusers: [],
    slots: { diffuser },
    spill: [],
    fitRadius: 1,
    height: 1,
    dispose(): void {},
  };
}

describe("applyEmission", () => {
  it("lifts emissive to white and forces a shader recompile only on the first call", () => {
    const diffuser = new MeshPhysicalMaterial({ emissive: 0x000000 });
    const model = fakeModel(diffuser);
    const versionBefore = diffuser.version;

    const ledTex1 = createLedTexture(UNWRAPPED);
    applyEmission(model, ledTex1, true, 100);
    expect(diffuser.emissive.r).toBe(1);
    expect(diffuser.emissive.g).toBe(1);
    expect(diffuser.emissive.b).toBe(1);
    expect(diffuser.emissiveMap).toBe(ledTex1.texture);
    expect(diffuser.version).toBeGreaterThan(versionBefore);

    // A second view of the same shared model binds a *different* texture
    // instance right before its own draw call (models/source.ts's
    // reparent-immediately-before-drawing discipline) — this must swap the
    // map without forcing another recompile.
    const versionAfterFirst = diffuser.version;
    const ledTex2 = createLedTexture(UNWRAPPED);
    applyEmission(model, ledTex2, true, 100);
    expect(diffuser.emissiveMap).toBe(ledTex2.texture);
    expect(diffuser.version).toBe(versionAfterFirst);
  });

  it("scales emissiveIntensity in proportion to brightnessGlow, with a gain above it", () => {
    const diffuser = new MeshPhysicalMaterial({ emissive: 0x000000 });
    const model = fakeModel(diffuser);
    const ledTex = createLedTexture(UNWRAPPED);

    applyEmission(model, ledTex, true, 40);
    const at40 = diffuser.emissiveIntensity;
    applyEmission(model, ledTex, true, 100);
    const at100 = diffuser.emissiveIntensity;

    // The ratio is what dimming means, and it must match the curve exactly.
    // The absolute value is not pinned to `brightnessGlow` itself: an emitter
    // is driven past display white on purpose, so the tone curve's highlight
    // roll-off has something to work with and a bright LED reads as bright
    // rather than merely pale. Asserting the constant here would turn a
    // deliberate look into a magic number two files have to agree on.
    expect(at40 / at100).toBeCloseTo(brightnessGlow(40) / brightnessGlow(100));
    expect(at100).toBeGreaterThan(brightnessGlow(100));
  });

  it("zeroes the LED buffer entirely when power is false, regardless of prior content", () => {
    const diffuser = new MeshPhysicalMaterial({ emissive: 0x000000 });
    const model = fakeModel(diffuser);
    const ledTex = createLedTexture(UNWRAPPED);
    ledTex.buffer.fill(200);

    applyEmission(model, ledTex, false, 100);

    expect(Array.from(ledTex.buffer).every((v) => v === 0)).toBe(true);
  });

  it("marks the texture dirty (version bump) on every call, powered or not", () => {
    const diffuser = new MeshPhysicalMaterial({ emissive: 0x000000 });
    const model = fakeModel(diffuser);
    const ledTex = createLedTexture(UNWRAPPED);

    const before = ledTex.texture.version;
    applyEmission(model, ledTex, true, 50);
    expect(ledTex.texture.version).toBeGreaterThan(before);

    const beforeOff = ledTex.texture.version;
    applyEmission(model, ledTex, false, 50);
    expect(ledTex.texture.version).toBeGreaterThan(beforeOff);
  });

  it("is a no-op when the model's diffuser slot isn't a MeshPhysicalMaterial", () => {
    const model: LampModel = {
      model: "TEST",
      object3D: undefined as never,
      leds: [],
      layout: UNWRAPPED,
      diffusers: [],
      slots: {},
      spill: [],
      fitRadius: 1,
      height: 1,
      dispose(): void {},
    };
    const ledTex = createLedTexture(UNWRAPPED);
    expect(() => applyEmission(model, ledTex, true, 50)).not.toThrow();
  });
});
