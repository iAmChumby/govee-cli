/**
 * The fallback body for a `model` string `sourceForModel()` (source.ts)
 * doesn't recognize — a device type added to the fleet after this file was
 * written, or malformed data. One emitter on a deliberately generic body, so
 * the light simulation always has *something* to draw rather than branching
 * on "no model" everywhere downstream.
 *
 * This is unrelated to the ledger's "unknown mode" honesty rule (CLAUDE.md:
 * "when the ledger has no entry the answer is unknown"). That rule governs
 * what colour a *known* device renders when its current activity can't be
 * classified; it is enforced by `led-field.ts` zeroing the LED buffer, not by
 * this file. A device with an unrecognized model can still report a real,
 * classifiable state and should still glow — it just does so on a generic
 * body instead of one built for its actual hardware.
 *
 * ## It should look deliberate, not broken
 *
 * The shape here is doing a specific job: saying "there is a real device
 * present, and this console does not have a model for it". Two failure modes
 * to avoid, and the reason this is a designed shape rather than a primitive:
 *
 *  - Too *specific* and a person reads it as a claim about their hardware —
 *    "my new lamp is that shape" — which is a fabrication in the same family
 *    as the colour ones this codebase works hard to avoid.
 *  - Too *crude* (the bare capsule this replaces) and it reads as a rendering
 *    bug rather than a considered fallback, which sends people debugging
 *    something that is working as designed.
 *
 * So: a plain frosted column on the same low dark plinth the H6022 uses. It
 * shares the visual family of the real models — same material language, same
 * plinth idiom — so it reads as belonging to this console, while its
 * featureless profile claims nothing about any particular product.
 *
 * ## Why this file needs no UV remapping (unlike h6022.ts / h6056.ts)
 *
 * `singleEmitterLayout()` always resolves to 1x1, so this body's
 * `emissiveMap` is a 1x1 `DataTexture` — every UV coordinate, whatever the
 * geometry assigns, samples that texture's one and only texel. There is no
 * multi-row or multi-column texture for a wrong UV to mis-sample, so the
 * class of bug fixed in `h6022.ts`/`h6056.ts` (compressing or smearing
 * several LED rows across the wrong band of a shared texture) cannot occur
 * here. That is a property of the 1x1 layout, not of the shape, so it
 * survives any future edit to the profile below.
 */

import {
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  Vector2,
  type Material,
  type BufferGeometry,
} from "three";
import { singleEmitterLayout, type LedPlacement, type LampModel, type ProceduralSource } from "./types";

const RADIUS = 0.5;

/** The plinth idiom shared with `h6022.ts`: low, and narrower than the body
 *  above it so the column overhangs and casts a shadow line into the gap. */
const PLINTH_HEIGHT = RADIUS * 0.22;
const PLINTH_FOOT_RADIUS = RADIUS * 0.9;
const PLINTH_TOP_RADIUS = RADIUS * 0.84;

const BODY_HEIGHT = RADIUS * 2.9;
const CAP_HEIGHT = RADIUS * 0.28;
const TOTAL_HEIGHT = PLINTH_HEIGHT + BODY_HEIGHT + CAP_HEIGHT;

const LATHE_SEGMENTS = 40;

function buildPlinthGeometry(): BufferGeometry {
  const profile = [
    new Vector2(0, 0),
    new Vector2(PLINTH_FOOT_RADIUS, 0),
    new Vector2(PLINTH_FOOT_RADIUS, PLINTH_HEIGHT * 0.55),
    new Vector2(PLINTH_TOP_RADIUS, PLINTH_HEIGHT),
    new Vector2(0, PLINTH_HEIGHT),
  ];
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/** A featureless frosted column with softly rounded ends — the "claims
 *  nothing about any product" shape described in the file header. */
function buildBodyGeometry(): BufferGeometry {
  const bodyTop = PLINTH_HEIGHT + BODY_HEIGHT;
  const profile = [
    new Vector2(PLINTH_TOP_RADIUS, PLINTH_HEIGHT),
    new Vector2(RADIUS * 0.98, PLINTH_HEIGHT + RADIUS * 0.06),
    new Vector2(RADIUS, PLINTH_HEIGHT + RADIUS * 0.16),
    new Vector2(RADIUS, bodyTop - RADIUS * 0.12),
    new Vector2(RADIUS * 0.96, bodyTop),
    new Vector2(RADIUS * 0.78, bodyTop + CAP_HEIGHT * 0.46),
    new Vector2(RADIUS * 0.44, bodyTop + CAP_HEIGHT * 0.82),
    new Vector2(0, TOTAL_HEIGHT),
  ];
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/** One emitter at the column's front face, mid-height — the same "single
 *  point that matters for spill" reasoning as the H6008's envelope centre. */
function placeLed(): LedPlacement {
  const y = PLINTH_HEIGHT + BODY_HEIGHT / 2;
  const position: readonly [number, number, number] = [0, y, RADIUS];
  return { index: 0, row: 0, col: 0, position, normal: [0, 0, 1] };
}

export const unknownSource: ProceduralSource = {
  kind: "procedural",
  // No layout is meaningful for a single-emitter fallback, so the parameter
  // is dropped entirely rather than accepted and ignored.
  build(): LampModel {
    const layout = singleEmitterLayout();
    const bodyGeometry = buildBodyGeometry();
    const plinthGeometry = buildPlinthGeometry();

    // Near-black before the LEDs turn on, matching every other model — see
    // h6022.ts's `buildDiffuser()` for why a mid-grey diffuser desaturates
    // the emissive term into grey.
    const diffuser = new MeshPhysicalMaterial({
      color: 0x18181d,
      roughness: 0.42,
      transmission: 0.55,
      thickness: 0.5,
      ior: 1.45,
      sheen: 0.25,
      sheenColor: 0xffffff,
      sheenRoughness: 0.45,
      // Left black on purpose: `emission.ts` lifts it to white exactly once,
      // when it first attaches the LED texture as `emissiveMap`.
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    const base = new MeshPhysicalMaterial({
      color: 0x1b1b20,
      roughness: 0.52,
      metalness: 0.22,
    });

    const bodyMesh = new Mesh(bodyGeometry, diffuser);
    const plinthMesh = new Mesh(plinthGeometry, base);
    const group = new Group();
    group.add(plinthMesh, bodyMesh);

    const led = placeLed();
    const halfHeight = TOTAL_HEIGHT / 2;
    const fitRadius = Math.max(
      Math.hypot(PLINTH_FOOT_RADIUS, halfHeight),
      Math.hypot(RADIUS, PLINTH_HEIGHT + BODY_HEIGHT - halfHeight),
    );

    let disposed = false;
    return {
      model: "",
      object3D: group,
      leds: [led],
      layout,
      diffusers: [bodyMesh],
      slots: { diffuser, base },
      spill: [{ position: led.position, ledIndices: [0] }],
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        bodyGeometry.dispose();
        plinthGeometry.dispose();
        (diffuser as Material).dispose();
        (base as Material).dispose();
      },
    };
  },
};
