/**
 * The H6056 (Light Bars, dual transport — see CLAUDE.md): two freestanding
 * light bars, each a tall thin capsule on a weighted foot, 96 LEDs total.
 *
 * Dimensions are proportional, not measured. The 2D stage's fixed-pixel body
 * (`motion-engine/geometry.ts`: each tube 34x196px) gives a height-to-width
 * ratio of 196/34 ~= 5.8, which is what `BAR_HEIGHT_RATIO` encodes below.
 *
 * ## Reading "2 x 48" as rows, not columns
 *
 * The design spec's prose describes the bars as "one column range per bar" of
 * a shared texture. But `layoutFromCapabilities()` (types.ts) reports this
 * model as `matrix_rows: 2, matrix_cols: 48` — the real capability is two
 * *rows* of 48 columns each, not one row split into two column ranges. A
 * column-range reading would need a single 96-wide row, which contradicts
 * both the capability the sidecar actually reports and the spec's own "48 per
 * bar" count (a column split of one 96-wide row cannot produce two disjoint
 * groups of exactly 48 without additional bookkeeping the capability doesn't
 * carry). This file follows the capability: **row 0 is the left bar, row 1 is
 * the right bar**, each with columns 0-47 running up that bar's length. That
 * is the reading that actually yields "48 per bar" from data already on the
 * wire, with no invented split logic.
 *
 * ## Two bars, one texture, two UV bands — not two identical samples
 *
 * The LED `DataTexture` the emission layer will upload is `cols x rows` =
 * 48 x 2, one texel row per bar (see the section above). A `CapsuleGeometry`'s
 * default UVs run the bar's full length over `v` in `[0, 1]` — correct for a
 * single bar sampling a whole texture, wrong for two bars sharing one. Both
 * bars would read `v` in the same `[0, 1]` range and sample an average of
 * *both* texture rows (with `NearestFilter`, whichever row rounding happens
 * to land on) instead of each bar showing only its own row. `remapUvToRow()`
 * below compresses each bar's existing length-wise `v` into that row's
 * `1/rows` slice of the texture (`row 0` -> `[0, 0.5]`, `row 1` -> `[0.5, 1]`
 * for this model's 2 rows), so `leftBar` and `rightBar` need their own
 * `BufferGeometry` — cloned from one template, not built twice — even though
 * they still share one `MeshPhysicalMaterial` and one texture. Geometry is
 * what carries the per-bar UV difference; the material and its `emissiveMap`
 * stay identical, and sharing them is still correct because the shared
 * texture already carries both rows' data.
 */

import {
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  type Material,
  type BufferGeometry,
} from "three";
import { ledIndex, type LedLayout, type LedPlacement, type LampModel, type ProceduralSource, type SpillCluster } from "./types";

/** Bar diameter is the unit of everything else here. */
const BAR_RADIUS = 0.5;
const BAR_DIAMETER = BAR_RADIUS * 2;

/** ~5.8x diameter, from the 34x196px tube (see file-level comment). */
const BAR_HEIGHT_RATIO = 5.8;
const BAR_TOTAL_HEIGHT = BAR_DIAMETER * BAR_HEIGHT_RATIO;

/** `CapsuleGeometry(radius, length, ...)`'s `length` is the straight
 *  cylindrical section only; the two hemispherical caps add `radius` each. */
const BAR_LENGTH = BAR_TOTAL_HEIGHT - BAR_DIAMETER;

/** A short, wide cylinder each bar appears to stand on — "weighted feet" per
 *  the spec, proportioned relative to the bar rather than measured. */
const FOOT_RADIUS = BAR_RADIUS * 1.4;
const FOOT_HEIGHT = BAR_DIAMETER * 0.3;

const TOTAL_HEIGHT = FOOT_HEIGHT + BAR_TOTAL_HEIGHT;

/** Gap between the two bars' centers, proportioned to bar width so they read
 *  as a freestanding pair rather than a single fused shape. */
const BAR_GAP = BAR_DIAMETER * 3;
const LEFT_X = -(BAR_RADIUS + BAR_GAP / 2);
const RIGHT_X = BAR_RADIUS + BAR_GAP / 2;

/** LEDs run up the straight cylindrical section of the capsule, staying clear
 *  of the rounded caps at each end. */
const COLUMN_MARGIN_FRAC = 0.03;

const CAP_SEGMENTS = 6;
const RADIAL_SEGMENTS = 16;

function buildBarGeometry(): BufferGeometry {
  const geometry = new CapsuleGeometry(BAR_RADIUS, BAR_LENGTH, CAP_SEGMENTS, RADIAL_SEGMENTS);
  // CapsuleGeometry is centered on its own origin, spanning
  // [-(BAR_LENGTH/2 + BAR_RADIUS), +(BAR_LENGTH/2 + BAR_RADIUS)]. Translate so
  // its bottom hemisphere is tangent to y = 0, then again so it rests on top
  // of the foot rather than passing through it.
  geometry.translate(0, BAR_TOTAL_HEIGHT / 2 + FOOT_HEIGHT, 0);
  return geometry;
}

function buildFootGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(FOOT_RADIUS, FOOT_RADIUS, FOOT_HEIGHT, 24);
  geometry.translate(0, FOOT_HEIGHT / 2, 0);
  return geometry;
}

/**
 * Rewrites a bar's UVs so it samples its own row of the shared `cols x rows`
 * (48 x 2) LED texture along its LENGTH.
 *
 * The axes have to be swapped, not just banded. `CapsuleGeometry` gives `u` the
 * circumferential coordinate and `v` the length-wise one, but the texture is 48
 * texels WIDE and 2 texels TALL: the 48 LEDs are the `u` axis and the choice of
 * bar is the `v` axis. Mapping the bar's length onto `v` — the obvious reading
 * of "row 0 is the left bar" — puts the 48 emitters around the tube's
 * circumference and leaves its whole length showing one colour, so a chase that
 * should climb the bar would instead run around it. `placeLeds` is unambiguous
 * about which way round it is: `col` drives `y`.
 *
 * So length-wise `v` becomes `u`, and `v` becomes the constant texel CENTRE of
 * this bar's row. A constant is right because each bar is exactly one texel row
 * — there is nothing to interpolate across — and the centre avoids the boundary
 * case where a vertex landing exactly on `row / rows` samples the neighbouring
 * bar's row under `NearestFilter`.
 *
 * The bar's `u` spans its whole capsule, hemispherical caps included, while
 * `placeLeds` insets the emitters into the cylindrical section. The 48 lit bands
 * are therefore stretched by a fraction of a texel relative to the LED
 * positions. That is a sub-texel offset on a 200px plate and it is stated here
 * rather than silently smoothed over; the emitters and the bands run along the
 * same axis in the same order, which is the property that matters.
 */
function remapUvToRow(geometry: BufferGeometry, row: number, rows: number): void {
  const uv = geometry.getAttribute("uv");
  if (!uv) throw new Error("h6056 bar geometry has no uv attribute to remap");
  const v = (row + 0.5) / rows;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, uv.getY(i));
    uv.setY(i, v);
  }
  uv.needsUpdate = true;
}

/** One capsule geometry per bar, cloned from a shared template so both keep
 *  the same shape but each gets its own `uv.y` band via `remapUvToRow()`. */
function buildBarGeometryForRow(row: number, rows: number): BufferGeometry {
  const template = buildBarGeometry();
  const geometry = template.clone();
  template.dispose();
  remapUvToRow(geometry, row, rows);
  return geometry;
}

/**
 * 96 LEDs: row 0 (left bar) and row 1 (right bar), 48 columns each running up
 * the bar's straight cylindrical section. LEDs face forward (+Z) — the side a
 * light bar is actually viewed from — rather than wrapping around the tube,
 * since a bar has no wrap-continuity requirement the way the H6022 drum does.
 */
function placeLeds(layout: LedLayout): LedPlacement[] {
  const { rows, cols } = layout;
  const cylinderBottom = FOOT_HEIGHT + BAR_RADIUS;
  const cylinderTop = FOOT_HEIGHT + BAR_RADIUS + BAR_LENGTH;
  const usable = (cylinderTop - cylinderBottom) * (1 - 2 * COLUMN_MARGIN_FRAC);
  const yStart = cylinderBottom + (cylinderTop - cylinderBottom) * COLUMN_MARGIN_FRAC;

  const placements: LedPlacement[] = [];
  for (let row = 0; row < rows; row++) {
    const x = row === 0 ? LEFT_X : RIGHT_X;
    for (let col = 0; col < cols; col++) {
      const colFrac = cols > 1 ? col / (cols - 1) : 0.5;
      const y = yStart + colFrac * usable;
      placements.push({
        index: ledIndex(layout, row, col),
        row,
        col,
        position: [x, y, BAR_RADIUS],
        normal: [0, 0, 1],
      });
    }
  }
  return placements;
}

/** One spill cluster per bar — the centroid of each bar's 48 LEDs — so a
 *  chase running up one bar casts light that moves with it independently of
 *  the other bar. */
function buildSpill(leds: LedPlacement[]): SpillCluster[] {
  const clusters: SpillCluster[] = [];
  for (const x of [LEFT_X, RIGHT_X]) {
    const inBar = leds.filter((l) => l.position[0] === x);
    if (inBar.length === 0) continue;
    const avgY = inBar.reduce((sum, l) => sum + l.position[1], 0) / inBar.length;
    clusters.push({ position: [x, avgY, BAR_RADIUS], ledIndices: inBar.map((l) => l.index) });
  }
  return clusters;
}

export const h6056Source: ProceduralSource = {
  kind: "procedural",
  build(layout: LedLayout): LampModel {
    // Each bar gets its own geometry (see the file-level "Two bars, one
    // texture" section) so its `uv.y` samples only its own row of the shared
    // 2x48 texture — the two bars still share one material and one foot
    // geometry, which have no per-bar UV to differentiate.
    const leftBarGeometry = buildBarGeometryForRow(0, layout.rows);
    const rightBarGeometry = buildBarGeometryForRow(1, layout.rows);
    const footGeometry = buildFootGeometry();

    const diffuser = new MeshPhysicalMaterial({
      color: 0xf2f2f2,
      roughness: 0.55,
      transmission: 0.6,
      thickness: 0.4,
      ior: 1.4,
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    const base = new MeshPhysicalMaterial({
      color: 0x3a3a3f,
      roughness: 0.35,
      metalness: 0.85,
    });

    // Each bar has its own geometry (differing only in uv.y band) but shares
    // one material — the spec's "one material set" per model, applied within
    // a single model instance as well as across the cache in source.ts. The
    // material can be shared safely because the per-bar difference lives
    // entirely in geometry UVs, not in anything the material carries.
    const leftBar = new Mesh(leftBarGeometry, diffuser);
    leftBar.position.x = LEFT_X;
    const rightBar = new Mesh(rightBarGeometry, diffuser);
    rightBar.position.x = RIGHT_X;

    const leftFoot = new Mesh(footGeometry, base);
    leftFoot.position.x = LEFT_X;
    const rightFoot = new Mesh(footGeometry, base);
    rightFoot.position.x = RIGHT_X;

    const group = new Group();
    group.add(leftFoot, rightFoot, leftBar, rightBar);

    const leds = placeLeds(layout);
    const fitRadius = Math.hypot(TOTAL_HEIGHT / 2, RIGHT_X + BAR_RADIUS);

    let disposed = false;
    return {
      model: "H6056",
      object3D: group,
      leds,
      layout,
      diffusers: [leftBar, rightBar],
      slots: { diffuser, base },
      spill: buildSpill(leds),
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        leftBarGeometry.dispose();
        rightBarGeometry.dispose();
        footGeometry.dispose();
        (diffuser as Material).dispose();
        (base as Material).dispose();
      },
    };
  },
};
