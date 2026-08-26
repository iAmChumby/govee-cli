/**
 * Tests for `cast-light.ts`'s pure/constructible surface: mean-colour maths,
 * spill light placement/recolouring, and the shared radial falloff texture.
 * Runs in the default Node vitest environment for the same reason
 * `emission.test.ts` does — building `THREE.PointLight`/`THREE.Sprite`/
 * `THREE.DataTexture` instances needs no GPU, only rendering them does.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PointLight } from "three";
import {
  castLightTestHooks,
  createHalo,
  createSpillLights,
  getRadialFalloffTexture,
  meanAllLedColor,
  meanLedColor,
  updateHalo,
  updateSpillLights,
} from "./cast-light";
import type { LampModel, SpillCluster } from "./models/types";

beforeEach(() => {
  castLightTestHooks.resetRadialTexture();
});

describe("meanLedColor", () => {
  it("averages the listed indices' RGB triples", () => {
    const buffer = new Uint8ClampedArray(9); // 3 LEDs
    buffer.set([255, 0, 0], 0);
    buffer.set([0, 255, 0], 3);
    buffer.set([0, 0, 255], 6);
    expect(meanLedColor(buffer, [0, 1, 2])).toEqual([255 / 3, 255 / 3, 255 / 3]);
  });

  it("returns black for an empty cluster rather than NaN", () => {
    const buffer = new Uint8ClampedArray(9);
    expect(meanLedColor(buffer, [])).toEqual([0, 0, 0]);
  });

  it("reads only the requested indices, not the whole buffer", () => {
    const buffer = new Uint8ClampedArray(9);
    buffer.set([100, 100, 100], 0);
    buffer.set([0, 0, 0], 3);
    buffer.set([200, 200, 200], 6);
    expect(meanLedColor(buffer, [0])).toEqual([100, 100, 100]);
    expect(meanLedColor(buffer, [2])).toEqual([200, 200, 200]);
  });
});

describe("meanAllLedColor", () => {
  it("averages every LED in the buffer with no index list", () => {
    const buffer = new Uint8ClampedArray(6); // 2 LEDs
    buffer.set([255, 255, 255], 0);
    buffer.set([0, 0, 0], 3);
    expect(meanAllLedColor(buffer)).toEqual([127.5, 127.5, 127.5]);
  });

  it("returns black for an empty buffer", () => {
    expect(meanAllLedColor(new Uint8ClampedArray(0))).toEqual([0, 0, 0]);
  });
});

function fakeModelWithSpill(spill: SpillCluster[]): LampModel {
  return {
    model: "TEST",
    object3D: undefined as never,
    leds: [],
    layout: { rows: 1, cols: 1, wrapCol: false },
    diffusers: [],
    slots: {},
    spill,
    fitRadius: 2,
    height: 3,
    dispose(): void {},
  };
}

describe("createSpillLights / updateSpillLights", () => {
  it("creates one PointLight per SpillCluster, positioned at the cluster's own position", () => {
    const spill: SpillCluster[] = [
      { position: [0, 1, 0], ledIndices: [0] },
      { position: [0, 2, 0], ledIndices: [1] },
    ];
    const model = fakeModelWithSpill(spill);
    const lights = createSpillLights(model);
    expect(lights).toHaveLength(2);
    expect(lights[0]).toBeInstanceOf(PointLight);
    expect([lights[0]!.position.x, lights[0]!.position.y, lights[0]!.position.z]).toEqual([0, 1, 0]);
    expect([lights[1]!.position.x, lights[1]!.position.y, lights[1]!.position.z]).toEqual([0, 2, 0]);
  });

  it("starts every light at zero intensity — an unrendered view contributes no light", () => {
    const model = fakeModelWithSpill([{ position: [0, 0, 0], ledIndices: [0] }]);
    const lights = createSpillLights(model);
    expect(lights[0]!.intensity).toBe(0);
  });

  it("recolours each light from the mean of its own cluster's LEDs, in lockstep by index", () => {
    const spill: SpillCluster[] = [
      { position: [0, 0, 0], ledIndices: [0] },
      { position: [1, 0, 0], ledIndices: [1] },
    ];
    const model = fakeModelWithSpill(spill);
    const lights = createSpillLights(model);
    const buffer = new Uint8ClampedArray(6);
    buffer.set([255, 0, 0], 0); // cluster 0's LED: red
    buffer.set([0, 0, 255], 3); // cluster 1's LED: blue

    updateSpillLights(lights, model, buffer, 1);

    expect(lights[0]!.color.r).toBeCloseTo(1);
    expect(lights[0]!.color.g).toBeCloseTo(0);
    expect(lights[0]!.color.b).toBeCloseTo(0);
    expect(lights[1]!.color.b).toBeCloseTo(1);
    expect(lights[1]!.color.r).toBeCloseTo(0);
  });

  it("scales intensity by brightnessFactor — zero when the caller passes zero (device off)", () => {
    const model = fakeModelWithSpill([{ position: [0, 0, 0], ledIndices: [0] }]);
    const lights = createSpillLights(model);
    const buffer = new Uint8ClampedArray(3);
    buffer.set([255, 255, 255], 0);

    updateSpillLights(lights, model, buffer, 0);
    expect(lights[0]!.intensity).toBe(0);

    updateSpillLights(lights, model, buffer, 1);
    expect(lights[0]!.intensity).toBeGreaterThan(0);
  });
});

describe("getRadialFalloffTexture", () => {
  it("is opaque white at the center and fully transparent at the corners", () => {
    const texture = getRadialFalloffTexture();
    const size = texture.image.width;
    const data = texture.image.data as Uint8Array;
    const centerIdx = Math.floor(size / 2);
    const centerOffset = (centerIdx * size + centerIdx) * 4;
    expect(data[centerOffset]).toBe(255); // R
    expect(data[centerOffset + 3]).toBeGreaterThan(200); // near-opaque alpha

    const cornerOffset = 0;
    expect(data[cornerOffset + 3]).toBe(0); // fully transparent at the far corner
  });

  it("is a shared singleton — repeated calls return the identical texture", () => {
    expect(getRadialFalloffTexture()).toBe(getRadialFalloffTexture());
  });
});

describe("createHalo / updateHalo", () => {
  it("starts fully transparent (no colour claimed before the first real update)", () => {
    const model = fakeModelWithSpill([]);
    const halo = createHalo(model);
    expect(halo.material.opacity).toBe(0);
  });

  it("colours the halo from the given mean and scales opacity by brightnessFactor", () => {
    const model = fakeModelWithSpill([]);
    const halo = createHalo(model);

    updateHalo(halo, [255, 0, 0], 1);
    expect(halo.material.color.r).toBeCloseTo(1);
    expect(halo.material.color.g).toBeCloseTo(0);
    const opacityAtFull = halo.material.opacity;
    expect(opacityAtFull).toBeGreaterThan(0);

    updateHalo(halo, [255, 0, 0], 0);
    expect(halo.material.opacity).toBe(0);
  });
});
