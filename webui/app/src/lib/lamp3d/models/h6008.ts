/**
 * The H6008 (GVH-series bulb — see CLAUDE.md's "BLE blocked, cloud working"
 * section): an A19-profile envelope on an Edison screw base.
 *
 * This model has **no addressable matrix** — capabilities report
 * `matrix_rows`/`matrix_cols` as 0, so `layoutFromCapabilities()` resolves it
 * to the 1x1 `singleEmitterLayout()` every downstream module already expects.
 * That is correct and deliberate: this bulb genuinely has one controllable
 * colour, and inventing a matrix for it to make the render more interesting
 * would be exactly the fabrication CLAUDE.md's first rule forbids.
 *
 * Dimensions are proportional, not measured. The envelope's widest radius is
 * the unit; the A19 proportions below (neck, shoulder, dome) come from the
 * standard bulb silhouette rather than from calipers on this specific device.
 *
 * ## What changed from the first pass, and why
 *
 * The first version was a bare `SphereGeometry` sitting on a stub cylinder.
 * Rendered small, on a dark stage, that is a grey ball on a black nub — which
 * is what got photographed and objected to. A sphere is not what makes
 * something read as a bulb; the **neck** does. A real A19 envelope necks down
 * from its widest point through a curved shoulder into the screw base, and
 * that transition is the whole silhouette.
 *
 * So the envelope is now a single `LatheGeometry` revolve through a real A19
 * profile, and the base is a second lathe with an actual Edison thread
 * suggested by four shallow ridges in its profile.
 *
 * The previous version's comment justified skipping threads as "vertex cost
 * for a detail that reads as noise at plate size". That reasoning was aimed
 * at modelling a true helical thread, which would indeed be expensive and
 * invisible. Four ridges in a lathe profile are eight extra profile points on
 * a 24-segment revolve — a few hundred triangles — and at plate size they do
 * not read as threads so much as they break up what was otherwise a flat grey
 * cylinder. That is worth paying for; a helix still is not, and is still not
 * modelled.
 *
 * ## Why this file needs no UV remapping (unlike h6022.ts / h6056.ts)
 *
 * Those two remap `uv` because their `emissiveMap` is a multi-texel texture
 * (11x12, 2x48) whose sampled colour depends on where each vertex's UV lands.
 * This model's layout is always the 1x1 `singleEmitterLayout()`, so its
 * `emissiveMap` is a 1x1 `DataTexture`: **every** UV coordinate on the
 * envelope — whatever `LatheGeometry` assigns, and whatever the profile is —
 * samples that texture's one and only texel. There is no class of
 * "compressed onto the wrong band" bug possible with a single texel, and
 * changing the geometry from a sphere to a lathe cannot introduce one. This
 * remains true for any future profile edit, which is why it is stated as a
 * property of the layout rather than of the shape.
 */

import {
  Group,
  LatheGeometry,
  SplineCurve,
  Mesh,
  MeshPhysicalMaterial,
  Vector2,
  type Material,
  type BufferGeometry,
} from "three";
import { singleEmitterLayout, type LedPlacement, type LampModel, type ProceduralSource } from "./types";

/** The envelope's widest radius — the unit of everything else here. */
const BULB_RADIUS = 0.5;

/** The Edison base, bottom-up: contact tip, insulator collar, threaded shell.
 *  Proportioned against the envelope the way an E26 base is against an A19
 *  glass. */
const TIP_RADIUS = BULB_RADIUS * 0.2;
const TIP_HEIGHT = BULB_RADIUS * 0.08;
const INSULATOR_TOP_RADIUS = BULB_RADIUS * 0.4;
const INSULATOR_TOP_Y = TIP_HEIGHT + BULB_RADIUS * 0.12;
const SCREW_RADIUS = BULB_RADIUS * 0.47;
const SCREW_TOP_Y = INSULATOR_TOP_Y + BULB_RADIUS * 0.6;

/** Four shallow ridges suggesting the thread. See the file header for why
 *  four ridges is a different proposition from modelling a helix. */
const THREAD_COUNT = 4;
const THREAD_DEPTH = BULB_RADIUS * 0.042;

/** The glass, from where it leaves the base to its apex. */
const NECK_TOP_Y = SCREW_TOP_Y + BULB_RADIUS * 0.32;
const WIDEST_Y = SCREW_TOP_Y + BULB_RADIUS * 1.0;
const TOTAL_HEIGHT = SCREW_TOP_Y + BULB_RADIUS * 1.84;

/** Angular smoothness of both revolves. A bulb is viewed close-up as a hero,
 *  so its silhouette carries more than a plate's does; 40 segments keeps the
 *  dome's edge clean without approaching the vertex budget. */
const LATHE_SEGMENTS = 40;

/** How many points the envelope's spline is sampled at. See
 *  `buildEnvelopeGeometry` — this is what turns eleven hand-placed control
 *  points into a smooth silhouette instead of eleven creases. 48 costs one
 *  extra ring of vertices per sample and removes the faceting entirely. */
const ENVELOPE_PROFILE_SAMPLES = 48;

/**
 * The metal screw base: contact tip, insulator collar, then the threaded
 * shell. Revolved from the axis so `LatheGeometry` pinches the bottom shut.
 *
 * The ridges are generated rather than written out, so `THREAD_COUNT` is a
 * real parameter instead of a number that would have to agree with a
 * hand-written list of vertices.
 */
function buildBaseGeometry(): BufferGeometry {
  const profile: Vector2[] = [
    new Vector2(0, 0),
    new Vector2(TIP_RADIUS, TIP_HEIGHT * 0.6),
    new Vector2(TIP_RADIUS * 1.15, TIP_HEIGHT),
    new Vector2(INSULATOR_TOP_RADIUS, INSULATOR_TOP_Y),
    new Vector2(SCREW_RADIUS, INSULATOR_TOP_Y + BULB_RADIUS * 0.04),
  ];

  const threadSpan = SCREW_TOP_Y - (INSULATOR_TOP_Y + BULB_RADIUS * 0.04);
  for (let i = 0; i < THREAD_COUNT; i++) {
    // Each ridge is a trough followed by a crest, evenly spaced up the shell.
    const lo = (i + 0.25) / THREAD_COUNT;
    const hi = (i + 0.75) / THREAD_COUNT;
    const baseY = INSULATOR_TOP_Y + BULB_RADIUS * 0.04;
    profile.push(new Vector2(SCREW_RADIUS - THREAD_DEPTH, baseY + threadSpan * lo));
    profile.push(new Vector2(SCREW_RADIUS, baseY + threadSpan * hi));
  }

  profile.push(new Vector2(SCREW_RADIUS * 0.94, SCREW_TOP_Y));
  profile.push(new Vector2(0, SCREW_TOP_Y));
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/**
 * The glass envelope: an A19 profile — a short neck leaving the base, a
 * curved shoulder flaring out to the widest point, then a dome closing to the
 * apex.
 *
 * Starts on the screw shell's own top radius so the two meshes meet with no
 * gap, the same shared-seam discipline `h6022.ts` uses between its plinth and
 * its shade.
 */
/**
 * The glass envelope: an A19 profile — a short neck leaving the base, a curved
 * shoulder flaring out to the widest point, then a dome closing to the apex.
 *
 * The control points below are **sampled through a `SplineCurve`** rather than
 * handed to `LatheGeometry` directly. A lathe interpolates linearly between
 * consecutive profile points, so eleven hand-placed points around a dome
 * produce eleven visible creases running around the bulb — which is exactly how
 * the first version of this rendered, as a faceted shell with ridges catching
 * the key light. Sampling a Catmull-Rom spline through the same control points
 * gives the profile enough resolution for the silhouette to read as blown glass
 * at a cost of a few dozen extra vertices in ONE ring of the revolve.
 *
 * Starts on the screw shell's own top radius so the two meshes meet with no
 * gap, the same shared-seam discipline `h6022.ts` uses between its plinth and
 * its shade.
 */
function buildEnvelopeGeometry(): BufferGeometry {
  const control = [
    new Vector2(SCREW_RADIUS * 0.94, SCREW_TOP_Y),
    new Vector2(SCREW_RADIUS * 1.04, SCREW_TOP_Y + BULB_RADIUS * 0.1),
    new Vector2(BULB_RADIUS * 0.62, NECK_TOP_Y),
    new Vector2(BULB_RADIUS * 0.84, SCREW_TOP_Y + BULB_RADIUS * 0.58),
    new Vector2(BULB_RADIUS * 0.96, SCREW_TOP_Y + BULB_RADIUS * 0.78),
    new Vector2(BULB_RADIUS, WIDEST_Y),
    new Vector2(BULB_RADIUS * 0.97, SCREW_TOP_Y + BULB_RADIUS * 1.22),
    new Vector2(BULB_RADIUS * 0.86, SCREW_TOP_Y + BULB_RADIUS * 1.46),
    new Vector2(BULB_RADIUS * 0.66, SCREW_TOP_Y + BULB_RADIUS * 1.66),
    new Vector2(BULB_RADIUS * 0.38, SCREW_TOP_Y + BULB_RADIUS * 1.79),
    new Vector2(0, TOTAL_HEIGHT),
  ];
  const profile = new SplineCurve(control).getPoints(ENVELOPE_PROFILE_SAMPLES);
  // `getPoints` returns samples of the curve, which passes THROUGH every
  // control point but can overshoot slightly between them. Clamp the radius so
  // an overshoot can never push the glass past its stated widest point (which
  // `fitRadius` and the spill placement below are both computed from) or
  // produce a negative radius at the apex, where a lathe would fold inside out.
  for (const point of profile) {
    point.x = Math.min(Math.max(point.x, 0), BULB_RADIUS);
  }
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/**
 * The single emitter, at the envelope's optical centre.
 *
 * There is no matrix to distribute across, so the position that matters is
 * the point `cast-light.ts` throws this bulb's one spill light from. That is
 * the middle of the glass — roughly the widest point's height, where a real
 * filament array sits — not the geometric centroid of the whole model, which
 * would sit down inside the metal base.
 */
function placeLed(): LedPlacement {
  const centre: readonly [number, number, number] = [0, WIDEST_Y, 0];
  return {
    index: 0,
    row: 0,
    col: 0,
    position: centre,
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
    const baseGeometry = buildBaseGeometry();

    // Near-black frosted glass. See h6022.ts's `buildDiffuser()` for the full
    // argument; it applies with extra force here, because this bulb's whole
    // visible body IS the diffuser — there is no second surface to carry the
    // object's form if the glass washes out. A mid-grey envelope was why a
    // bulb reporting `#330066` rendered as a grey ball.
    //
    // `thickness` is higher than the other models': an A19 envelope is a
    // large air volume behind thin glass, and a thicker transmission path is
    // what makes it read as a lit VOLUME rather than a lit shell.
    const diffuser = new MeshPhysicalMaterial({
      color: 0x191920,
      // Frosted, not glossy. At 0.3 the envelope picked up discrete highlights
      // from the shared `RoomEnvironment` PMREM and rendered them as pale
      // blotches across the lit dome — a bulb should scatter that reflection,
      // not mirror it.
      roughness: 0.5,
      transmission: 0.62,
      thickness: 0.72,
      ior: 1.45,
      sheen: 0.3,
      sheenColor: 0xffffff,
      sheenRoughness: 0.35,
      // Left black on purpose: `emission.ts` lifts it to white exactly once,
      // when it first attaches the LED texture as `emissiveMap`.
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    // Satin nickel rather than a mirror: high metalness with real roughness,
    // so it catches the key light as a soft band instead of reflecting the
    // whole environment map.
    const metal = new MeshPhysicalMaterial({
      color: 0x3c3c42,
      roughness: 0.42,
      metalness: 0.9,
    });

    const envelopeMesh = new Mesh(envelopeGeometry, diffuser);
    const baseMesh = new Mesh(baseGeometry, metal);

    const group = new Group();
    group.add(baseMesh, envelopeMesh);

    const led = placeLed();
    // Bounding radius about the model's own mid-height. The apex and the
    // widest ring are the two candidates; the screw base is well inside both.
    const halfHeight = TOTAL_HEIGHT / 2;
    const fitRadius = Math.max(
      Math.abs(TOTAL_HEIGHT - halfHeight),
      Math.hypot(BULB_RADIUS, WIDEST_Y - halfHeight),
      halfHeight,
    );

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
        baseGeometry.dispose();
        (diffuser as Material).dispose();
        (metal as Material).dispose();
      },
    };
  },
};
