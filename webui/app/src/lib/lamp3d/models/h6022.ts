/**
 * The H6022 (RGBIC Table Lamp 2, see CLAUDE.md's "FULLY WORKING" section): a
 * frosted cylindrical drum shade standing on a low dark plinth, 132 LEDs
 * wrapped around the drum as an 11-row x 12-column matrix
 * (`index = row * 12 + col`).
 *
 * Dimensions are proportional, not measured. The 2D stage's fixed-pixel body
 * (`motion-engine/geometry.ts`: a 112x238px drum) plus product photography
 * put the drum's height at roughly 1.7x its diameter — that ratio is what the
 * height constants below encode, not a millimetre spec. Real dimensions would
 * refine this and are welcome later; this file does not claim an accuracy it
 * does not have.
 *
 * ## What changed from the first pass, and why
 *
 * The first version was a bare extruded cylinder on a foot 1.35x WIDER than
 * the shade, which is a proportion no table lamp has — it read as two
 * primitives stacked, which is what a person looking at the render said about
 * it. Three changes fix that without meaningful vertex cost:
 *
 *  - **The plinth is now narrower than the drum** (`PLINTH_TOP_RADIUS` vs
 *    `DRUM_RADIUS`), so the shade overhangs it and casts a shadow line into
 *    the gap. An overhang is most of what makes a shade read as sitting ON
 *    something rather than fused to it.
 *  - **Rolled rims** bracketing the wall. A moulded diffuser has a radius
 *    where its wall turns; a hard 90-degree edge is the single strongest
 *    "this is a primitive" cue, and the rims cost four profile points.
 *  - **Materials that let the LEDs win.** See `buildDiffuser()`.
 *
 * The body stays two `LatheGeometry` revolves rather than one:
 * `LatheGeometry`'s own index buffer interleaves radial segments with profile
 * bands (see `node_modules/three/src/geometries/LatheGeometry.js`), so a
 * single mesh split into "opaque plinth" and "translucent shade" material
 * groups would need one `geometry.addGroup()` call per radial segment (dozens
 * of tiny groups) for no visual benefit. Two lathes whose profiles share the
 * exact vertex at the plinth/shade seam produce the same continuous
 * silhouette — "one silhouette", not necessarily one `BufferGeometry`.
 *
 * ## The wall is a true cylinder, deliberately
 *
 * A slight barrel would catch the key light more interestingly, and it was
 * tried. It is wrong here: `models.test.ts` asserts every LED sits at the
 * same radius from the drum's Y axis AND on the shade's actual rendered
 * surface, and those two assertions together encode a real property of this
 * hardware — 12 columns of emitters at one radius, wrapped around a cylinder.
 * A barrelled wall would put each row at its own radius and turn "the LED is
 * on the surface" into a per-row question. The visual interest comes from the
 * rims and the material instead, which cost nothing in correctness.
 *
 * ## UV mapping is by HEIGHT, not by profile-point index
 *
 * `LatheGeometry` assigns `uv.y = j / (points.length - 1)`, where `j` is the
 * *index* of a profile point, not its arc length or its `y` coordinate
 * (`node_modules/three/src/geometries/LatheGeometry.js:156`). With the
 * 11-point profile below, the LED-bearing wall spans exactly one index step
 * out of ten — left at the default, all 11 LED rows would compress into a
 * tenth of the shade and the dome would smear the top row across itself.
 *
 * The previous version fixed this by remapping from named profile-point
 * INDICES. That worked, and it would have broken silently the moment the
 * profile changed: adding the rims shifts every index, and neither the type
 * system nor the tests would flag it — the render just quietly rescales,
 * which is the exact failure mode this file's comments exist to prevent.
 *
 * `remapWallUv()` maps from the vertex's own **y coordinate** instead:
 * `v = (y - WALL_BOTTOM_Y) / WALL_HEIGHT`, clamped to [0, 1]. That is immune
 * to profile edits, and — the reason it is correct rather than merely
 * convenient — it is *the same expression* `placeLeds()` inverts to position
 * the emitters. The texel a surface point samples and the LED that lights it
 * now derive from one pair of span constants, so they cannot drift apart.
 * Everything below `WALL_BOTTOM_Y` clamps to `v = 0` and everything above
 * `WALL_TOP_Y` clamps to `v = 1`: there is no LED on the rims or the dome, so
 * they read whatever their adjacent row shows rather than an invented value.
 *
 * `uv.x` needs no correction: `LatheGeometry` sets `uv.x = i / segments`
 * independent of the profile, already running `0..1` once around the full
 * circumference, which is what lets `wrapS = RepeatWrapping` join column 11
 * back to column 0 without a seam.
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
import { ledIndex, type LedLayout, type LedPlacement, type LampModel, type ProceduralSource, type SpillCluster } from "./types";

/** Drum radius is the unit of everything else in this file — every other
 *  constant is expressed as a ratio of it, per the "proportional, not
 *  measured" rule above. */
const DRUM_RADIUS = 0.5;
const DRUM_DIAMETER = DRUM_RADIUS * 2;

/** The plinth: low, and narrower than the shade so the drum overhangs it.
 *  `PLINTH_TOP_RADIUS` is what the shade's bottom rim curls in to meet, and
 *  the difference between it and `DRUM_RADIUS` is the shadow gap that makes
 *  the two read as separate manufactured parts. */
const PLINTH_HEIGHT = DRUM_DIAMETER * 0.11;
const PLINTH_FOOT_RADIUS = DRUM_RADIUS * 0.924;
const PLINTH_TOP_RADIUS = DRUM_RADIUS * 0.872;

/** The straight, LED-bearing section of the shade, and the rims and dome that
 *  bracket it. They sum with `PLINTH_HEIGHT` to ~1.7x the drum's diameter —
 *  the proportion from the file header — rather than the wall alone carrying
 *  that ratio: 0.11 + 0.066 + 1.42 + 0.05 + 0.051 = 1.697 against a diameter
 *  of 1. Getting this wrong is visible instantly and was: an earlier pass put
 *  1.7x on the WALL's own constant and then subtracted the rims from it,
 *  which rendered a drum barely taller than it was wide. */
const BOTTOM_RIM_HEIGHT = DRUM_DIAMETER * 0.066;
const WALL_HEIGHT = DRUM_DIAMETER * 1.42;
const TOP_RIM_HEIGHT = DRUM_DIAMETER * 0.05;
const DOME_HEIGHT = DRUM_DIAMETER * 0.051;

/** The two heights the LED wall spans. **These are the file's load-bearing
 *  constants**: `remapWallUv()` maps texture `v` across exactly this span and
 *  `placeLeds()` positions emitters across exactly this span, so the texel a
 *  surface point samples and the LED that lights it derive from one source
 *  rather than from two that merely happen to agree. */
const WALL_BOTTOM_Y = PLINTH_HEIGHT + BOTTOM_RIM_HEIGHT;
const WALL_TOP_Y = WALL_BOTTOM_Y + WALL_HEIGHT;

const TOTAL_HEIGHT = WALL_TOP_Y + TOP_RIM_HEIGHT + DOME_HEIGHT;

/** Angular smoothness of the revolve. A multiple of 12 so the visual facets
 *  loosely line up with the 12 LED columns, though LED placement below is
 *  computed independently of this and would be correct at any value. 60
 *  segments x 11 profile points is ~1,300 triangles for the shade — well
 *  inside the budget for a dozen of these on one dashboard through a single
 *  shared renderer. */
const LATHE_SEGMENTS = 60;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The dark plinth. Revolves from the axis (r = 0) out to the foot, up a
 * straight side with one shallow lip, then in to `PLINTH_TOP_RADIUS` — where
 * the shade's own profile starts, so the two meshes meet with zero gap and
 * zero overlap. The r = 0 endpoints pinch the revolve shut at both ends,
 * which is how `LatheGeometry` closes a solid.
 */
function buildPlinthGeometry(): BufferGeometry {
  const profile = [
    new Vector2(0, 0),
    new Vector2(PLINTH_FOOT_RADIUS, 0),
    new Vector2(PLINTH_FOOT_RADIUS, PLINTH_HEIGHT * 0.5),
    // A shallow lip two-thirds up. One profile point, and it gives the key
    // light a horizontal line to catch — which is most of what separates
    // "moulded part" from "cylinder" at plate size.
    new Vector2(PLINTH_FOOT_RADIUS * 1.014, PLINTH_HEIGHT * 0.66),
    new Vector2(PLINTH_FOOT_RADIUS * 0.99, PLINTH_HEIGHT * 0.82),
    new Vector2(PLINTH_TOP_RADIUS, PLINTH_HEIGHT),
    new Vector2(0, PLINTH_HEIGHT),
  ];
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/**
 * The frosted shade: a bottom roll flaring from the plinth out to the wall,
 * the straight LED-bearing wall, a top roll, and a shallow dome closing it.
 *
 * **Exactly two profile points sit at `DRUM_RADIUS`** — the wall's own two
 * ends. Every rim and dome point is strictly inside it. That is deliberate,
 * and `models.test.ts` depends on it: the test finds the shade's
 * maximum-radius band and asserts every LED lies on it, so the band has to BE
 * the wall. A rim vertex at exactly `DRUM_RADIUS` would widen that band into
 * the rims and weaken the assertion into something that no longer proves the
 * emitters sit where the light comes out.
 */
function buildShadeGeometry(): BufferGeometry {
  const topRimTop = WALL_TOP_Y + TOP_RIM_HEIGHT;
  const profile = [
    // Starts on the plinth's own top vertex — the shared seam.
    new Vector2(PLINTH_TOP_RADIUS, PLINTH_HEIGHT),
    new Vector2(DRUM_RADIUS * 0.966, PLINTH_HEIGHT + BOTTOM_RIM_HEIGHT * 0.42),
    new Vector2(DRUM_RADIUS * 0.994, PLINTH_HEIGHT + BOTTOM_RIM_HEIGHT * 0.78),
    new Vector2(DRUM_RADIUS, WALL_BOTTOM_Y),
    new Vector2(DRUM_RADIUS, WALL_TOP_Y),
    new Vector2(DRUM_RADIUS * 0.994, WALL_TOP_Y + TOP_RIM_HEIGHT * 0.38),
    new Vector2(DRUM_RADIUS * 0.962, WALL_TOP_Y + TOP_RIM_HEIGHT * 0.74),
    new Vector2(DRUM_RADIUS * 0.9, topRimTop),
    new Vector2(DRUM_RADIUS * 0.72, topRimTop + DOME_HEIGHT * 0.42),
    new Vector2(DRUM_RADIUS * 0.4, topRimTop + DOME_HEIGHT * 0.82),
    new Vector2(0, TOTAL_HEIGHT),
  ];
  const geometry = new LatheGeometry(profile, LATHE_SEGMENTS);
  remapWallUv(geometry);
  return geometry;
}

/**
 * Overrides `LatheGeometry`'s index-based `uv.y` (see the file header for why
 * the default is wrong and why height beats profile index) so the LED-bearing
 * wall spans `v` in [0, 1] and everything outside it clamps to the adjacent
 * edge.
 *
 * Reads each vertex's own `position.y` rather than walking `LatheGeometry`'s
 * `j + i * pointCount` vertex layout, so it stays correct for any profile —
 * including one a future edit adds points to, which is exactly what would
 * have silently broken the index-based version this replaced.
 */
function remapWallUv(geometry: BufferGeometry): void {
  const uv = geometry.getAttribute("uv");
  const position = geometry.getAttribute("position");
  if (!uv) throw new Error("h6022 shade geometry has no uv attribute to remap");
  if (!position) throw new Error("h6022 shade geometry has no position attribute to remap from");
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, clamp01((position.getY(i) - WALL_BOTTOM_Y) / WALL_HEIGHT));
  }
  uv.needsUpdate = true;
}

/**
 * Places every emitter on the TEXEL CENTRE of the cell that will light it.
 *
 * The shade's `v` spans the LED wall over [0, 1] (see `remapWallUv`) and the
 * emissive texture is `cols x rows`, so texel `row` lights the band `v` in
 * `[row / rows, (row + 1) / rows)` — whose centre is at `(row + 0.5) / rows`.
 * Spreading the rows edge-to-edge instead (`row / (rows - 1)`) leaves each
 * emitter sitting off-centre in its own lit band, by up to a third of a band
 * at the extremes: the model would claim an LED at one height while the light
 * appeared at another, and the spill lights — positioned from these very
 * coordinates — would drift from the glow they are supposed to be caused by.
 *
 * The same argument fixes the angular step: `LatheGeometry` sets
 * `uv.x = i / segments` over a full revolution, so `u` is exactly
 * `angle / 2pi`, and texel `col` covers `[col / cols, (col + 1) / cols)`. The
 * half-step offset centres each LED in its own column band.
 *
 * `(0.5 / rows)` also insets the top and bottom rows from the wall's ends on
 * its own, which is what a hand-tuned margin constant would have approximated.
 *
 * `layout.rows`/`layout.cols` come from capabilities rather than being
 * hardcoded, so this keeps working if the sidecar ever reports a different
 * matrix for this model.
 */
function placeLeds(layout: LedLayout): LedPlacement[] {
  const { rows, cols } = layout;

  const placements: LedPlacement[] = [];
  for (let row = 0; row < rows; row++) {
    const y = WALL_BOTTOM_Y + WALL_HEIGHT * ((row + 0.5) / rows);
    for (let col = 0; col < cols; col++) {
      const angle = ((col + 0.5) / cols) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      placements.push({
        index: ledIndex(layout, row, col),
        row,
        col,
        position: [DRUM_RADIUS * cos, y, DRUM_RADIUS * sin],
        // Radially outward on a cylinder: (cos, 0, sin) is already unit
        // length by construction (cos^2 + sin^2 = 1), so no normalize() pass
        // is needed.
        normal: [cos, 0, sin],
      });
    }
  }
  return placements;
}

/** 2-4 spill clusters per the shared `SpillCluster` contract. The drum is
 *  split into three height bands (bottom/middle/top third of its rows) so a
 *  chase running up or around the drum still moves the cast light with it,
 *  rather than every LED collapsing into one static point light. */
function buildSpill(leds: LedPlacement[], layout: LedLayout): SpillCluster[] {
  const bands = 3;
  const clusters: SpillCluster[] = [];
  for (let b = 0; b < bands; b++) {
    const rowLo = Math.floor((b * layout.rows) / bands);
    const rowHi = Math.floor(((b + 1) * layout.rows) / bands);
    const inBand = leds.filter((l) => l.row >= rowLo && l.row < rowHi);
    if (inBand.length === 0) continue;
    const avgY = inBand.reduce((sum, l) => sum + l.position[1], 0) / inBand.length;
    clusters.push({
      position: [0, avgY, 0],
      ledIndices: inBand.map((l) => l.index),
    });
  }
  return clusters;
}

/**
 * The frosted polycarbonate shade.
 *
 * **`color` is near-black on purpose, and it is half the fix for "the models
 * don't emit their light colors at all."** The previous value was `0x6e6e73`
 * — mid grey. Under this scene's ambient + key + environment, that grey's own
 * NEUTRAL diffuse response lands at a luminance comparable to the emissive
 * term for any colour a person actually sets, and being neutral it
 * desaturates the sum: a lamp reporting `#330066` at 50% rendered as a
 * grey-lavender body, which is what got photographed and reported. A dark
 * shade still reads as a white shade in a dark room the moment it is lit —
 * that is what a diffuser DOES — and it leaves the whole bright end of the
 * range for the emitters to claim. See renderer.ts's exposure-budget comment
 * for the other half of the same argument.
 *
 * `sheen` is the second half of "light inside an object rather than a texture
 * on it": it lifts grazing angles, so the silhouette's edge glows and the
 * shade reads as a lit volume rather than a painted cylinder. It costs a
 * shader branch, which is worth paying on the one surface per model that is
 * supposed to look like it is glowing.
 *
 * `transmission` stays moderate rather than high. Transmission attenuates the
 * diffuse term and shows what is BEHIND the object, which on a dark stage is
 * more darkness; pushed high it removes body without adding glow, since
 * emissive is added after it. `source.ts`'s `setDiffuserQuality()` drops it to
 * 0 for plates and restores it from `userData.baseTransmission` for the hero.
 */
function buildDiffuser(): MeshPhysicalMaterial {
  const diffuser = new MeshPhysicalMaterial({
    color: 0x18181d,
    roughness: 0.4,
    transmission: 0.55,
    thickness: 0.5,
    ior: 1.46,
    sheen: 0.25,
    sheenColor: 0xffffff,
    sheenRoughness: 0.45,
    // Left black on purpose: `emission.ts` lifts it to white exactly once,
    // when it first attaches the LED texture as `emissiveMap`, and relies on
    // its `hadNoMap` guard being true only once per shared material's whole
    // lifetime.
    emissive: 0x000000,
  });
  // setDiffuserQuality() (source.ts) restores this value for the hero tier
  // after dropping it to 0 for plates; stashing the authored value on the
  // material itself means that switch never has to hardcode the number.
  diffuser.userData.baseTransmission = diffuser.transmission;
  return diffuser;
}

export const h6022Source: ProceduralSource = {
  kind: "procedural",
  build(layout: LedLayout): LampModel {
    const shadeGeometry = buildShadeGeometry();
    const plinthGeometry = buildPlinthGeometry();

    const diffuser = buildDiffuser();

    // Soft-touch dark plastic, not chrome. `roughness 0.35, metalness 0.85` —
    // the previous values — render as a black mirror that reflects the
    // environment map and reads as a chrome puck under the shade. A real
    // Govee base is a matte dark polymer with a faint specular sheen, which
    // is high roughness and low metalness.
    const base = new MeshPhysicalMaterial({
      color: 0x1b1b20,
      roughness: 0.52,
      metalness: 0.22,
    });

    const shadeMesh = new Mesh(shadeGeometry, diffuser);
    const plinthMesh = new Mesh(plinthGeometry, base);

    const group = new Group();
    group.add(plinthMesh, shadeMesh);

    const leds = placeLeds(layout);
    // Bounding radius about the model's own mid-height, which is what
    // renderer.ts's cameraFitDistance() frames from. The silhouette's widest
    // point is the wall at DRUM_RADIUS, but the point FARTHEST from the
    // mid-height centre is the plinth's foot ring down at y = 0, so the
    // enclosing radius is the larger of those two distances rather than
    // either one alone.
    const halfHeight = TOTAL_HEIGHT / 2;
    const fitRadius = Math.max(
      Math.hypot(PLINTH_FOOT_RADIUS, halfHeight),
      Math.hypot(DRUM_RADIUS, WALL_TOP_Y - halfHeight),
    );

    let disposed = false;
    return {
      model: "H6022",
      object3D: group,
      leds,
      layout,
      diffusers: [shadeMesh],
      slots: { diffuser, base },
      spill: buildSpill(leds, layout),
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        shadeGeometry.dispose();
        plinthGeometry.dispose();
        (diffuser as Material).dispose();
        (base as Material).dispose();
      },
    };
  },
};
