/**
 * The fallback body for a `model` string `sourceForModel()` (source.ts)
 * doesn't recognize — a device type added to the fleet after this file was
 * written, or malformed data. A neutral capsule with one emitter, so the
 * light simulation always has *something* to draw rather than branching on
 * "no model" everywhere downstream.
 *
 * This is unrelated to the ledger's "unknown mode" honesty rule (CLAUDE.md:
 * "when the ledger has no entry the answer is unknown"). That rule governs
 * what color a *known* device renders when its current activity can't be
 * classified; it is enforced by `led-field.ts` zeroing the LED buffer, not by
 * this file. A device with an unrecognized model can still report a real,
 * classifiable state and should still glow — it just does so on a generic
 * capsule instead of a shape built for its actual hardware.
 *
 * ## Why this file needs no UV remapping (unlike h6022.ts / h6056.ts)
 *
 * `singleEmitterLayout()` always resolves to 1x1, so this capsule's
 * `emissiveMap` is a 1x1 `DataTexture` — with `NearestFilter`, every UV on
 * `CapsuleGeometry`'s default mapping samples that texture's one texel.
 * There is no multi-row or multi-column texture for a wrong UV to
 * mis-sample, so the class of bug fixed in `h6022.ts`/`h6056.ts` (compressing
 * or smearing several LED rows across the wrong band of a shared texture)
 * cannot occur here.
 */

import { CapsuleGeometry, Group, Mesh, MeshPhysicalMaterial, type Material, type BufferGeometry } from "three";
import { singleEmitterLayout, type LedPlacement, type LampModel, type ProceduralSource } from "./types";

const RADIUS = 0.5;
const LENGTH = 1.6;
const TOTAL_HEIGHT = LENGTH + RADIUS * 2;

const CAP_SEGMENTS = 6;
const RADIAL_SEGMENTS = 16;

function buildGeometry(): BufferGeometry {
  const geometry = new CapsuleGeometry(RADIUS, LENGTH, CAP_SEGMENTS, RADIAL_SEGMENTS);
  geometry.translate(0, TOTAL_HEIGHT / 2, 0);
  return geometry;
}

/** One emitter at the capsule's front face, mid-height — the same "single
 *  point that matters for spill" reasoning as the H6008's bulb center. */
function placeLed(): LedPlacement {
  const position: readonly [number, number, number] = [0, TOTAL_HEIGHT / 2, RADIUS];
  return { index: 0, row: 0, col: 0, position, normal: [0, 0, 1] };
}

export const unknownSource: ProceduralSource = {
  kind: "procedural",
  // No layout is meaningful for a single-emitter fallback, so the parameter
  // is dropped entirely rather than accepted and ignored.
  build(): LampModel {
    const layout = singleEmitterLayout();
    const geometry = buildGeometry();

    const diffuser = new MeshPhysicalMaterial({
      // A diffuser that is near-white before the LEDs turn on saturates under
      // any environment and leaves emission with nowhere to go — see
      // renderer.ts's exposure-budget comment. A dimmer base still reads as a
      // white shade in a dark room and leaves the bright end to the emitters.
      color: 0x6e6e73,
      roughness: 0.55,
      transmission: 0.6,
      thickness: 0.4,
      ior: 1.4,
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    const mesh = new Mesh(geometry, diffuser);
    const group = new Group();
    group.add(mesh);

    const led = placeLed();
    const fitRadius = Math.hypot(TOTAL_HEIGHT / 2, RADIUS);

    let disposed = false;
    return {
      model: "",
      object3D: group,
      leds: [led],
      layout,
      diffusers: [mesh],
      slots: { diffuser },
      spill: [{ position: led.position, ledIndices: [0] }],
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        geometry.dispose();
        (diffuser as Material).dispose();
      },
    };
  },
};
