/**
 * The H6008 (GVH-series bulb — see CLAUDE.md's "BLE blocked, cloud working"
 * section): a sphere-ish bulb envelope on a threaded socket cylinder. This
 * model has no addressable matrix (`matrix_rows`/`matrix_cols` are 0 in
 * capabilities), so `layoutFromCapabilities()` resolves it to the 1x1 single
 * emitter every downstream module already expects.
 *
 * Dimensions are proportional, not measured. The 2D stage's fixed-pixel body
 * (`motion-engine/geometry.ts`: a 116px bulb circle) sets the envelope's
 * relative size; the socket below it is sized off the envelope, not measured
 * from a real fixture.
 *
 * No literal screw threads are modeled — a plain cylinder stands in for the
 * socket. Actual thread geometry would add vertex cost for a detail that
 * reads as noise at plate size and is invisible behind the diffuser's own
 * glow at hero size; if that changes, replace `buildSocketGeometry()` without
 * touching anything else in this file.
 *
 * ## Why this file needs no UV remapping (unlike h6022.ts / h6056.ts)
 *
 * The H6022 shade and H6056 bars each remap `uv` because their `emissiveMap`
 * is a multi-texel texture (11x12, 2x48) whose sampled colour actually
 * depends on where each vertex's UV lands. This model's `layoutFromCapabilities()`
 * result is always the 1x1 `singleEmitterLayout()`, so its `emissiveMap` is a
 * 1x1 `DataTexture` — with `NearestFilter`, every UV coordinate on the
 * envelope samples that texture's one and only texel, so `SphereGeometry`'s
 * default UVs (whatever they are) cannot produce a wrong sample. There is no
 * class of "compressed onto the wrong band" bug possible with a single texel.
 */

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  SphereGeometry,
  type Material,
  type BufferGeometry,
} from "three";
import { singleEmitterLayout, type LedPlacement, type LampModel, type ProceduralSource } from "./types";

/** Envelope diameter is the unit of everything else here. */
const BULB_RADIUS = 0.5;

const SOCKET_RADIUS = BULB_RADIUS * 0.55;
const SOCKET_HEIGHT = BULB_RADIUS * 0.6;

const TOTAL_HEIGHT = SOCKET_HEIGHT + BULB_RADIUS * 2;

const SPHERE_WIDTH_SEGMENTS = 24;
const SPHERE_HEIGHT_SEGMENTS = 16;

function buildEnvelopeGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(BULB_RADIUS, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);
  // Centered on its own origin by default; lift so its bottom sits on top of
  // the socket rather than passing through it.
  geometry.translate(0, SOCKET_HEIGHT + BULB_RADIUS, 0);
  return geometry;
}

function buildSocketGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(SOCKET_RADIUS, SOCKET_RADIUS * 1.1, SOCKET_HEIGHT, 20);
  geometry.translate(0, SOCKET_HEIGHT / 2, 0);
  return geometry;
}

/** One emitter, placed at the envelope's own center with an upward normal —
 *  there is no matrix to distribute across, so the "position" that matters is
 *  the point `cast-light.ts` would put a single spill light at. */
function placeLed(): LedPlacement {
  const center: readonly [number, number, number] = [0, SOCKET_HEIGHT + BULB_RADIUS, 0];
  return {
    index: 0,
    row: 0,
    col: 0,
    position: center,
    normal: [0, 1, 0],
  };
}

export const h6008Source: ProceduralSource = {
  kind: "procedural",
  // This model has exactly one emitter regardless of what layout the caller
  // passes — matching the contract's own singleEmitterLayout() rather than
  // trusting an incoming layout that shouldn't exist for this hardware. The
  // parameter is dropped entirely rather than accepted and ignored.
  build(): LampModel {
    const layout = singleEmitterLayout();

    const envelopeGeometry = buildEnvelopeGeometry();
    const socketGeometry = buildSocketGeometry();

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

    const metal = new MeshPhysicalMaterial({
      color: 0x4a4a4a,
      roughness: 0.35,
      metalness: 0.85,
    });

    const envelopeMesh = new Mesh(envelopeGeometry, diffuser);
    const socketMesh = new Mesh(socketGeometry, metal);

    const group = new Group();
    group.add(socketMesh, envelopeMesh);

    const led = placeLed();
    const fitRadius = Math.hypot(TOTAL_HEIGHT / 2, BULB_RADIUS);

    let disposed = false;
    return {
      model: "H6008",
      object3D: group,
      leds: [led],
      layout,
      diffusers: [envelopeMesh],
      slots: { diffuser, metal },
      spill: [{ position: led.position, ledIndices: [0] }],
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        envelopeGeometry.dispose();
        socketGeometry.dispose();
        (diffuser as Material).dispose();
        (metal as Material).dispose();
      },
    };
  },
};
