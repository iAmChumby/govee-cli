/**
 * The H6022 (RGBIC Table Lamp 2, see CLAUDE.md's "FULLY WORKING" section): a
 * cylindrical drum shade on a tapered metal base, 132 LEDs wrapped around the
 * drum as an 11-row x 12-column matrix (`index = row * 12 + col`).
 *
 * Dimensions are proportional, not measured. The 2D stage's fixed-pixel body
 * (`motion-engine/geometry.ts`: a 112x238px drum) plus product photography
 * put the drum's height at roughly 1.7x its diameter — that ratio is what
 * `DRUM_HEIGHT_RATIO` encodes below, not a millimetre spec. Real dimensions
 * would refine this and are welcome later; this file does not claim an
 * accuracy it does not have.
 *
 * The body is two `LatheGeometry` revolves rather than one: `LatheGeometry`'s
 * own index buffer interleaves radial segments with profile bands (see
 * `node_modules/three/src/geometries/LatheGeometry.js`), so a single mesh
 * split into "opaque base" and "translucent shade" material groups would need
 * one `geometry.addGroup()` call per radial segment (dozens of tiny groups)
 * for no visual benefit. Two lathes whose profiles share the exact vertex at
 * the base/shade seam produce the same continuous silhouette the spec asks
 * for — "one silhouette", not necessarily one `BufferGeometry` — while
 * keeping the metal foot and the frosted shade as separate materials the
 * simple way.
 *
 * ## LatheGeometry's default `uv.y` is by profile-point index, not by height
 *
 * `LatheGeometry` assigns `uv.y = j / (points.length - 1)`, where `j` is the
 * *index* of a profile point, not its arc length or its `y` coordinate
 * (`node_modules/three/src/geometries/LatheGeometry.js:156`). The shade's
 * 4-point profile spans the whole LED-bearing wall between points 0 and 1 —
 * one quarter of the four evenly-spaced index slots, `v` in `[0, 0.333]` —
 * and the tiny LED-free dome across points 1-2-3, `v` in `[0.333, 1]`. Left
 * at the default, an 11-row LED texture applied through `emissiveMap` would
 * compress all 11 rows into the bottom third of the shade and smear the
 * top row's colour across the dome. `remapShadeUv()` below overrides `uv.y`
 * so the wall alone spans `[0, 1]` and the dome clamps to the wall's top
 * edge (`v = 1`) — there is no LED there to show a gradient, so it reads
 * whatever the top row shows rather than an invented value. `uv.x` needs no
 * correction: `LatheGeometry` sets `uv.x = i / segments` independent of the
 * profile, already running `0..1` once around the full circumference, which
 * is what lets `wrapS = RepeatWrapping` join column 11 back to column 0
 * without a seam.
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

/** Drum diameter is the unit of everything else in this file — every other
 *  constant is expressed as a ratio of it, per the "proportional, not
 *  measured" rule above. */
const DRUM_RADIUS = 0.5;
const DRUM_DIAMETER = DRUM_RADIUS * 2;

/** ~1.7x diameter, from the 112x238px drum body plus product photography
 *  (see file-level comment) — a proportion, not a millimetre measurement. */
const DRUM_HEIGHT_RATIO = 1.7;
const DRUM_HEIGHT = DRUM_DIAMETER * DRUM_HEIGHT_RATIO;

/** The tapered foot is wider than the drum for visual stability, and short
 *  relative to the shade — a table lamp's base, not a plinth. */
const FOOT_RADIUS = DRUM_RADIUS * 1.35;
const BASE_HEIGHT = DRUM_HEIGHT * 0.18;

/** A slight dome closing the top of the shade rather than leaving it a bare
 *  open cylinder — reads better under a key light without changing the
 *  silhouette's proportions in any way that matters to LED placement. */
const CAP_HEIGHT = DRUM_HEIGHT * 0.06;

const TOTAL_HEIGHT = BASE_HEIGHT + DRUM_HEIGHT + CAP_HEIGHT;

/** Angular smoothness of the revolve. A multiple of 12 so the visual facets
 *  loosely line up with the 12 LED columns, though LED placement below is
 *  computed independently of this and would be correct at any value. */
const LATHE_SEGMENTS = 48;


function buildBaseGeometry(): BufferGeometry {
  // Revolve from the drum's own axis (r=0) out to the foot radius and back in
  // to meet the shade's radius exactly at y = BASE_HEIGHT, closing the bottom
  // as a flat disc the way LatheGeometry expects (an r=0 endpoint pinches the
  // revolve shut).
  const profile = [
    new Vector2(0, 0),
    new Vector2(FOOT_RADIUS, 0),
    new Vector2(FOOT_RADIUS * 0.92, BASE_HEIGHT * 0.35),
    new Vector2(DRUM_RADIUS, BASE_HEIGHT),
  ];
  return new LatheGeometry(profile, LATHE_SEGMENTS);
}

/** Profile-point indices into `buildShadeGeometry()`'s `profile` array — the
 *  LED-bearing wall runs from `WALL_BOTTOM_POINT` to `WALL_TOP_POINT`;
 *  everything after `WALL_TOP_POINT` is the LED-free dome. Named rather than
 *  inlined so `remapShadeUv()` reads as "the wall's two endpoints", not two
 *  bare array indices that happen to be 0 and 1. */
const WALL_BOTTOM_POINT = 0;
const WALL_TOP_POINT = 1;

/**
 * Overrides `LatheGeometry`'s default `uv.y` (see the file-level "LatheGeometry's
 * default uv.y" section for why the default is wrong here) so the
 * LED-bearing wall spans `v` in `[0, 1]` and the dome above it clamps to the
 * wall's top edge rather than inheriting an index-based share of `v` it has
 * no LEDs to justify.
 *
 * Walks the same `j + i * pointCount` vertex layout `LatheGeometry` itself
 * builds (one column of `pointCount` profile vertices per of the `segments +
 * 1` radial steps — the `+ 1` because the revolve emits a seam column at
 * `i = segments` coincident with `i = 0`), so every radial column gets an
 * identical `v` ramp regardless of `i`.
 */
function remapShadeUv(geometry: BufferGeometry, pointCount: number, segments: number): void {
  const uv = geometry.getAttribute("uv");
  if (!uv) throw new Error("h6022 shade geometry has no uv attribute to remap");
  const wallSpan = WALL_TOP_POINT - WALL_BOTTOM_POINT;
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j < pointCount; j++) {
      const index = j + i * pointCount;
      const v = Math.min(1, Math.max(0, (j - WALL_BOTTOM_POINT) / wallSpan));
      uv.setY(index, v);
    }
  }
  uv.needsUpdate = true;
}

function buildShadeGeometry(): BufferGeometry {
  // Starts at the same (DRUM_RADIUS, BASE_HEIGHT) vertex the base ends on, so
  // the two meshes meet with zero gap and zero overlap — the "one silhouette"
  // the spec asks for, built from two lathes rather than one for the
  // material-grouping reason in the file-level comment.
  const profile = [
    new Vector2(DRUM_RADIUS, BASE_HEIGHT), // WALL_BOTTOM_POINT
    new Vector2(DRUM_RADIUS, BASE_HEIGHT + DRUM_HEIGHT), // WALL_TOP_POINT
    new Vector2(DRUM_RADIUS * 0.985, BASE_HEIGHT + DRUM_HEIGHT + CAP_HEIGHT * 0.55),
    new Vector2(0, BASE_HEIGHT + DRUM_HEIGHT + CAP_HEIGHT),
  ];
  const geometry = new LatheGeometry(profile, LATHE_SEGMENTS);
  remapShadeUv(geometry, profile.length, LATHE_SEGMENTS);
  return geometry;
}

/**
 * 132 LEDs on the drum's outer surface: 11 rows climbing the straight wall,
 * 12 columns evenly spaced around the full 2*PI. `layout.rows`/`layout.cols`
 * come from capabilities rather than being hardcoded here, so this keeps
 * working if the sidecar ever reports a different matrix for this model.
 *
 * Wrap continuity: `angle(col) = (col / cols) * 2*PI` is linear in `col`, so
 * the angular step from column `cols-1` back to column `0` (a full turn
 * later) is `2*PI / cols` — identical to the step between any other adjacent
 * pair. That is what lets `matrix_wrap_col` drive a seamless `RepeatWrapping`
 * texture: there is no seam in the geometry to hide.
 */
/**
 * Places every emitter on the TEXEL CENTRE of the cell that will light it.
 *
 * The shade's `v` now spans the LED wall over `[0, 1]` (see `remapShadeUv`) and
 * the emissive texture is `cols x rows` with `NearestFilter`, so texel `row`
 * lights the band `v` in `[row / rows, (row + 1) / rows)` — whose centre is at
 * `(row + 0.5) / rows`. Spreading the rows edge-to-edge instead (an inset
 * fraction, then `row / (rows - 1)`) leaves each emitter sitting off-centre in
 * its own lit band, by up to a third of a band at the extremes: the model would
 * claim an LED at one height while the light appeared at another, and the spill
 * lights — which are positioned from these very coordinates — would drift from
 * the glow they are supposed to be caused by.
 *
 * The same argument fixes the angular step: `LatheGeometry` sets
 * `uv.x = i / segments` over a full revolution, so `u` is exactly
 * `angle / 2pi`, and texel `col` covers `[col / cols, (col + 1) / cols)`. The
 * half-step offset centres each LED in its own column band.
 *
 * `(0.5 / rows)` also insets the top and bottom rows from the shade's rims on
 * its own, which is what the hand-tuned margin constant was approximating.
 */
function placeLeds(layout: LedLayout): LedPlacement[] {
  const { rows, cols } = layout;

  const placements: LedPlacement[] = [];
  for (let row = 0; row < rows; row++) {
    const y = BASE_HEIGHT + DRUM_HEIGHT * ((row + 0.5) / rows);
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

export const h6022Source: ProceduralSource = {
  kind: "procedural",
  build(layout: LedLayout): LampModel {
    const shadeGeometry = buildShadeGeometry();
    const baseGeometry = buildBaseGeometry();

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
    // setDiffuserQuality() (source.ts) restores this value for the hero tier
    // after dropping it to 0 for plates; stashing the authored value on the
    // material itself means that switch never has to hardcode the number.
    diffuser.userData.baseTransmission = diffuser.transmission;

    const base = new MeshPhysicalMaterial({
      color: 0x3a3a3f,
      roughness: 0.35,
      metalness: 0.85,
    });

    const shadeMesh = new Mesh(shadeGeometry, diffuser);
    const baseMesh = new Mesh(baseGeometry, base);

    const group = new Group();
    group.add(baseMesh, shadeMesh);

    const leds = placeLeds(layout);
    const fitRadius = Math.hypot(TOTAL_HEIGHT / 2, FOOT_RADIUS);

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
        baseGeometry.dispose();
        (diffuser as Material).dispose();
        (base as Material).dispose();
      },
    };
  },
};
