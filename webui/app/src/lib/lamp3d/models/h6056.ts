/**
 * The H6056 (Light Bars, dual transport — see CLAUDE.md): two flat-fronted
 * light bars, each standing in a circular swivel yoke on a weighted base,
 * 96 LEDs total.
 *
 * Dimensions are proportional, not measured. The 2D stage's fixed-pixel body
 * (`motion-engine/geometry.ts`: each tube 34x196px) gives a height-to-width
 * ratio of 196/34 ~= 5.8, which is roughly what `BAR_HEIGHT` encodes below
 * against the bar's width.
 *
 * ## What changed from the first pass, and why
 *
 * The first version was two `CapsuleGeometry` tubes on two plain cylinders.
 * A capsule is the wrong solid for this product in a way that matters beyond
 * taste: the real bar has a **flat front face** that is the diffuser, set into
 * a dark shell, and it stands in a **circular yoke** it pivots within. The
 * yoke is the product's whole visual signature and it was simply absent. A
 * round tube also implies the light wraps its circumference, which is the
 * opposite of what this hardware does.
 *
 * So each bar is now three parts: an extruded rounded-rectangle shell, a flat
 * diffuser panel inset into its front, and a torus yoke rising from a low
 * circular base. The bars are pitched back a few degrees inside their yokes
 * and toed in toward each other, because that is how a person actually places
 * a pair on a desk, and because two perfectly vertical parallel sticks read as
 * a diagram rather than an object.
 *
 * ## Reading "2 x 48" as rows, not columns
 *
 * The design spec's prose describes the bars as "one column range per bar" of
 * a shared texture. But `layoutFromCapabilities()` (types.ts) reports this
 * model as `matrix_rows: 2, matrix_cols: 48` — the real capability is two
 * *rows* of 48 columns each, not one row split into two column ranges. A
 * column-range reading would need a single 96-wide row, which contradicts both
 * the capability the sidecar actually reports and the spec's own "48 per bar"
 * count (a column split of one 96-wide row cannot produce two disjoint groups
 * of exactly 48 without additional bookkeeping the capability doesn't carry).
 * This file follows the capability: **row 0 is the left bar, row 1 is the
 * right bar**, each with columns 0-47 running up that bar's length.
 *
 * ## Two bars, one texture, and which axis is which
 *
 * The LED `DataTexture` `emission.ts` uploads is `cols x rows` = **48 texels
 * wide, 2 texels tall**. So the 48 emitters are the texture's `u` axis and the
 * choice of bar is its `v` axis.
 *
 * That is the opposite of what a plain front panel gives you. `PlaneGeometry`
 * assigns `u` across its width and `v` up its height, so the obvious mapping
 * — "the bar's length is its height, so length is `v`" — would run the 48
 * emitters across the bar's narrow WIDTH and leave its whole length showing
 * one colour. A chase that should climb the bar would instead sweep across it,
 * and it would look like a perfectly plausible animation while being wrong.
 * `placeLeds` is unambiguous about which way round it is: `col` drives height.
 *
 * `remapFaceUv()` therefore **swaps the axes**: the panel's own height
 * fraction becomes `u`, and `v` becomes the constant texel CENTRE of this
 * bar's row. A constant `v` is right because each bar is exactly one texel row
 * — there is nothing to interpolate across — and the centre `(row + 0.5) /
 * rows` avoids the boundary case where a vertex landing exactly on
 * `row / rows` samples the neighbouring bar's row.
 *
 * The flat panel also removes a caveat the capsule version had to state and
 * live with. There, `u` spanned the whole capsule including its hemispherical
 * caps while the emitters were inset into the cylindrical section, so the lit
 * bands sat a fraction of a texel off from the LEDs. Here the panel IS the
 * LED-bearing region: its height fraction and the emitter's own column
 * fraction are the same number, exactly.
 *
 * Both bars still share one `MeshPhysicalMaterial` and one texture, with
 * **cloned geometries** carrying the per-bar UV difference. Geometry is what
 * differs per bar; the material and its `emissiveMap` are identical, and
 * sharing them is correct because the shared texture already carries both
 * rows' data.
 *
 * ## Emitter positions are read back from the rendered transform
 *
 * The bars are pitched and toed in, so an emitter's world position is no
 * longer something a couple of constants describe. Rather than deriving it a
 * second time in `placeLeds` — the exact duplication `models.test.ts` exists
 * to catch drift in — this file builds the scene graph first, calls
 * `updateMatrixWorld(true)`, and reads each emitter's position back out
 * through `faceMesh.localToWorld()`. The LED placements become a
 * *consequence* of the transform the renderer actually draws, so they cannot
 * disagree with it.
 */

import {
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  PlaneGeometry,
  CylinderGeometry,
  Quaternion,
  Shape,
  TorusGeometry,
  Vector3,
  type Material,
  type BufferGeometry,
} from "three";
import { ledIndex, type LedLayout, type LedPlacement, type LampModel, type ProceduralSource, type SpillCluster } from "./types";

/** Bar width is the unit of everything else here. */
const BAR_WIDTH = 0.5;
/** Shallower than it is wide — a light bar is a slab, not a post. */
const BAR_DEPTH = BAR_WIDTH * 0.66;
/** ~4.6x width. Shorter than the old capsule's 5.8x height-to-DIAMETER ratio
 *  because that ratio was measured against a round tube's diameter, and this
 *  bar's width is its widest dimension rather than its only one. */
const BAR_HEIGHT = BAR_WIDTH * 4.6;

/** Radius of the rounded vertical edges of the bar's cross-section. */
const SHELL_CORNER_RADIUS = BAR_DEPTH * 0.34;

/** The lit face, set into the shell's front so it reads as a panel in a body
 *  rather than a sticker on one.
 *
 *  `FACE_PROUD` is measured from the shell's **actual bounding box**, not from
 *  `BAR_DEPTH / 2`. That distinction is the whole reason this comment exists:
 *  `ExtrudeGeometry`'s `bevelSize` extends the contour OUTWARD from the shape's
 *  outline, so the solid's real half-depth is `BAR_DEPTH / 2 + bevelSize`, and
 *  a face placed at `BAR_DEPTH / 2 + a small epsilon` sits INSIDE the shell.
 *  It did: the shell's front reached z 0.2367 while the face stopped at 0.2093,
 *  so the panel was buried and both bars rendered as dark slabs with a lit
 *  halo behind them — emission that was being computed and uploaded correctly
 *  and could not be seen. Deriving the position from the geometry makes the
 *  constant unable to disagree with the shape it is positioned against. */
const FACE_WIDTH = BAR_WIDTH * 0.7;
const FACE_HEIGHT = BAR_HEIGHT * 0.9;
const FACE_PROUD = BAR_WIDTH * 0.016;

/** The yoke: a full circle the bar pivots inside, meeting the base at its
 *  lowest point. This is the part that makes the model recognisable. */
const YOKE_RADIUS = BAR_WIDTH * 0.86;
const YOKE_TUBE = BAR_WIDTH * 0.055;

const BASE_RADIUS = BAR_WIDTH * 0.92;
const BASE_HEIGHT = BAR_WIDTH * 0.17;

/** Height of the yoke's centre — the point the bar pitches about. Placed so
 *  the yoke's lowest point tucks into the base rather than floating above it
 *  or clipping through it. */
const PIVOT_Y = BASE_HEIGHT * 0.62 + YOKE_RADIUS;

/** The bar's bottom end, before pitch. Just clear of the base's top face. */
const BAR_BOTTOM_Y = BASE_HEIGHT + BAR_WIDTH * 0.04;

/** Pitched back inside the yoke, and toed in toward its partner. Small
 *  angles: enough to read as placed by a person rather than by a grid, small
 *  enough that each bar's emitters still climb monotonically in world Y,
 *  which `models.test.ts` asserts and which a steep pitch would break. */
const BAR_PITCH_RADIANS = 0.075;
const BAR_TOE_IN_RADIANS = 0.13;

/** Half the gap between the two bars' base centres. */
const BAR_HALF_SPACING = BAR_WIDTH * 1.85;

const TOTAL_HEIGHT = BAR_BOTTOM_Y + BAR_HEIGHT * Math.cos(BAR_PITCH_RADIANS);

/**
 * The bar's cross-section: a rounded rectangle, `BAR_WIDTH` across and
 * `BAR_DEPTH` deep, drawn in the shape plane's XY and extruded along its Z.
 *
 * `Shape` has no rounded-rect primitive, so the four corners are quadratic
 * curves between the four straight runs. The radius is clamped against the
 * half-extents so a future change to `BAR_DEPTH` cannot produce a
 * self-intersecting outline.
 */
function buildShellShape(): Shape {
  const halfW = BAR_WIDTH / 2;
  const halfD = BAR_DEPTH / 2;
  const r = Math.min(SHELL_CORNER_RADIUS, halfW * 0.9, halfD * 0.9);

  const shape = new Shape();
  shape.moveTo(-halfW + r, -halfD);
  shape.lineTo(halfW - r, -halfD);
  shape.quadraticCurveTo(halfW, -halfD, halfW, -halfD + r);
  shape.lineTo(halfW, halfD - r);
  shape.quadraticCurveTo(halfW, halfD, halfW - r, halfD);
  shape.lineTo(-halfW + r, halfD);
  shape.quadraticCurveTo(-halfW, halfD, -halfW, halfD - r);
  shape.lineTo(-halfW, -halfD + r);
  shape.quadraticCurveTo(-halfW, -halfD, -halfW + r, -halfD);
  shape.closePath();
  return shape;
}

/**
 * The dark shell, extruded from `buildShellShape()` and stood upright.
 *
 * `ExtrudeGeometry` always extrudes along +Z, so the result is rotated -90
 * degrees about X to stand the extrusion axis up: that maps `(x, y, z)` to
 * `(x, z, -y)`, so the extrusion range `z` in `[0, BAR_HEIGHT]` becomes world
 * `y` in `[0, BAR_HEIGHT]` and the cross-section's depth axis lands on `z`
 * still centred on zero. The geometry therefore stands with its base at its
 * own local `y = 0`, which is what the caller positions from.
 *
 * The bevel rounds the top and bottom ends. It is small and cheap: two
 * segments, and it is the difference between a bar that looks moulded and one
 * that looks cut with a saw.
 */
function buildShellGeometry(): BufferGeometry {
  const geometry = new ExtrudeGeometry(buildShellShape(), {
    depth: BAR_HEIGHT,
    bevelEnabled: true,
    bevelThickness: BAR_WIDTH * 0.022,
    bevelSize: BAR_WIDTH * 0.022,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Swaps a front panel's UV axes so its LENGTH indexes the texture's 48
 * columns, and pins `v` to this bar's own texel row.
 *
 * See the file header's "which axis is which" section for why the swap is
 * necessary rather than cosmetic. `PlaneGeometry`'s `v` runs 0 at the bottom
 * edge to 1 at the top, so after the swap `u` runs 0 at the bar's bottom to 1
 * at its top — the same direction `placeLeds` runs `col`, which is what makes
 * column 0 the bottom emitter on both bars.
 */
function remapFaceUv(geometry: BufferGeometry, row: number, rows: number): void {
  const uv = geometry.getAttribute("uv");
  if (!uv) throw new Error("h6056 face geometry has no uv attribute to remap");
  const v = (row + 0.5) / rows;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, uv.getY(i));
    uv.setY(i, v);
  }
  uv.needsUpdate = true;
}

/**
 * One bar's lit face. Segmented along its length so the emissive texture's 48
 * bands interpolate smoothly rather than across two triangles spanning the
 * whole bar — `LinearFilter` magnification does the blending, but it can only
 * blend what the rasteriser interpolates between, and a 1-segment quad gives
 * it two endpoints for 48 texels.
 */
function buildFaceGeometry(row: number, rows: number, cols: number): BufferGeometry {
  // Segmented along its length by the emitter count the layout actually
  // reports, not a hardcoded 48. `LinearFilter` magnification can only blend
  // between values the rasteriser interpolates, and a 1-segment quad gives it
  // two endpoints to span every texel with — so the segment count has to track
  // `cols` or the bands stop lining up with the mesh the moment the sidecar
  // reports a different matrix.
  const geometry = new PlaneGeometry(FACE_WIDTH, FACE_HEIGHT, 1, Math.max(1, cols));
  remapFaceUv(geometry, row, rows);
  return geometry;
}

function buildYokeGeometry(): BufferGeometry {
  return new TorusGeometry(YOKE_RADIUS, YOKE_TUBE, 10, 40);
}

function buildBaseGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(BASE_RADIUS, BASE_RADIUS * 1.02, BASE_HEIGHT, 36);
  geometry.translate(0, BASE_HEIGHT / 2, 0);
  return geometry;
}

/** One bar's assembled scene-graph node, plus the face mesh the emitters are
 *  read back off. */
interface BarParts {
  group: Group;
  faceMesh: Mesh;
}

/**
 * Assembles one bar: base and yoke standing upright, and a pitched inner
 * group carrying the shell and its lit face.
 *
 * The pitch is applied by a group positioned AT the yoke's centre and rotated
 * there, with its children offset by `-PIVOT_Y` — so the bar rotates about the
 * point the yoke actually grips it, the way the real hinge does, rather than
 * about its own base or the world origin.
 */
function buildBar(row: number, rows: number, cols: number, side: number, materials: BarMaterials): BarParts {
  const group = new Group();

  const baseMesh = new Mesh(materials.baseGeometry, materials.shell);
  const yokeMesh = new Mesh(materials.yokeGeometry, materials.shell);
  yokeMesh.position.y = PIVOT_Y;
  group.add(baseMesh, yokeMesh);

  const pitched = new Group();
  pitched.position.y = PIVOT_Y;
  // Negative, so the bar leans BACK and its face aims slightly upward — a
  // rotation of +theta about X sends the face normal (0, 0, 1) to
  // (0, -sin theta, cos theta), i.e. tilts it down at the floor, which is the
  // opposite of how anyone aims a light bar on a desk.
  pitched.rotation.x = -BAR_PITCH_RADIANS;

  const shellMesh = new Mesh(materials.shellGeometry, materials.shell);
  shellMesh.position.y = BAR_BOTTOM_Y - PIVOT_Y;

  const faceMesh = new Mesh(buildFaceGeometry(row, rows, cols), materials.diffuser);
  faceMesh.position.set(
    0,
    BAR_BOTTOM_Y + BAR_HEIGHT / 2 - PIVOT_Y,
    materials.shellFrontZ + FACE_PROUD,
  );
  pitched.add(shellMesh, faceMesh);
  group.add(pitched);

  group.position.x = side * BAR_HALF_SPACING;
  // Toe-in: each bar yaws toward the centre line, so `side` sets the sign.
  group.rotation.y = -side * BAR_TOE_IN_RADIANS;

  return { group, faceMesh };
}

/**
 * 96 LEDs: row 0 (left bar), row 1 (right bar), 48 columns each climbing that
 * bar's lit face.
 *
 * Positions are read back out of the built scene graph rather than
 * recomputed — see the file header's last section. Each emitter sits at the
 * TEXEL CENTRE of the band that lights it: column `col` covers `u` in
 * `[col / cols, (col + 1) / cols)` after `remapFaceUv`, whose centre is
 * `(col + 0.5) / cols`. The previous version spread them edge-to-edge with
 * `col / (cols - 1)`, which left every emitter off-centre in its own lit band
 * — the same mistake `h6022.ts`'s `placeLeds` comment documents at length,
 * and it was live here while being fixed there.
 *
 * `layout.rows`/`layout.cols` come from capabilities rather than being
 * hardcoded, so this keeps working if the sidecar ever reports a different
 * matrix for this model.
 */
function placeLeds(layout: LedLayout, bars: readonly BarParts[]): LedPlacement[] {
  const { rows, cols } = layout;
  const placements: LedPlacement[] = [];

  for (let row = 0; row < rows; row++) {
    const bar = bars[row];
    if (!bar) continue;
    // The world transform has to be current before localToWorld can be
    // trusted: three only refreshes matrices during a render, and this model
    // is built long before its first frame.
    bar.faceMesh.updateMatrixWorld(true);
    const normal = new Vector3(0, 0, 1)
      .applyQuaternion(bar.faceMesh.getWorldQuaternion(new Quaternion()))
      .normalize();

    for (let col = 0; col < cols; col++) {
      const lengthFrac = (col + 0.5) / cols;
      // PlaneGeometry spans [-h/2, +h/2] about its own origin, and its v runs
      // bottom-to-top, so fraction 0 is the bottom edge.
      const local = new Vector3(0, (lengthFrac - 0.5) * FACE_HEIGHT, 0);
      const world = bar.faceMesh.localToWorld(local);
      placements.push({
        index: ledIndex(layout, row, col),
        row,
        col,
        position: [world.x, world.y, world.z],
        normal: [normal.x, normal.y, normal.z],
      });
    }
  }
  return placements;
}

/**
 * One spill cluster per bar — the centroid of that bar's 48 LEDs — so a chase
 * running up one bar casts light that moves with it independently of the
 * other.
 *
 * Partitions by `row`, which IS the bar (see the file header), rather than by
 * matching an emitter's x coordinate against a constant. The old version did
 * the latter and it only worked while the bars were axis-aligned; with toe-in
 * and pitch applied, no emitter's x equals a build-time constant any more.
 */
function buildSpill(leds: readonly LedPlacement[], layout: LedLayout): SpillCluster[] {
  const clusters: SpillCluster[] = [];
  for (let row = 0; row < layout.rows; row++) {
    const inBar = leds.filter((l) => l.row === row);
    if (inBar.length === 0) continue;
    const n = inBar.length;
    const cx = inBar.reduce((s, l) => s + l.position[0], 0) / n;
    const cy = inBar.reduce((s, l) => s + l.position[1], 0) / n;
    const cz = inBar.reduce((s, l) => s + l.position[2], 0) / n;
    clusters.push({ position: [cx, cy, cz], ledIndices: inBar.map((l) => l.index) });
  }
  return clusters;
}

/** Everything one `build()` call shares across its two bars. Geometries for
 *  the base and yoke are shared outright (both bars render the same shape);
 *  the shell geometry is shared too, since only the FACE differs per bar, by
 *  its UVs. */
interface BarMaterials {
  diffuser: MeshPhysicalMaterial;
  shell: MeshPhysicalMaterial;
  shellGeometry: BufferGeometry;
  /** The shell's real front surface in its own local space — see
   *  `FACE_PROUD`. Measured from the built geometry rather than assumed from
   *  `BAR_DEPTH`, because the extrude bevel makes the solid thicker than the
   *  cross-section it was authored from. */
  shellFrontZ: number;
  yokeGeometry: BufferGeometry;
  baseGeometry: BufferGeometry;
}

/** The shell's frontmost z in its own local space. */
function measureShellFrontZ(shellGeometry: BufferGeometry): number {
  shellGeometry.computeBoundingBox();
  const box = shellGeometry.boundingBox;
  if (!box) throw new Error("h6056 shell geometry has no bounding box to measure");
  return box.max.z;
}

export const h6056Source: ProceduralSource = {
  kind: "procedural",
  build(layout: LedLayout): LampModel {
    // Near-black before the LEDs turn on, with a grazing-angle sheen lift.
    // See h6022.ts's `buildDiffuser()` for the full argument — the short
    // version is that a mid-grey diffuser's own neutral diffuse response
    // desaturates the emissive term into grey, which is the reported
    // "the models don't emit their light colors at all".
    const diffuser = new MeshPhysicalMaterial({
      color: 0x17171c,
      roughness: 0.36,
      transmission: 0.5,
      thickness: 0.32,
      ior: 1.46,
      sheen: 0.25,
      sheenColor: 0xffffff,
      sheenRoughness: 0.4,
      // Left black on purpose: `emission.ts` lifts it to white exactly once,
      // when it first attaches the LED texture as `emissiveMap`.
      emissive: 0x000000,
    });
    diffuser.userData.baseTransmission = diffuser.transmission;

    // Matte dark polymer for shell, yoke and base alike — one material for
    // every non-emitting surface on the model. The previous
    // `roughness 0.35, metalness 0.85` rendered as a black mirror.
    const shell = new MeshPhysicalMaterial({
      color: 0x1a1a1e,
      roughness: 0.55,
      metalness: 0.25,
    });

    const shellGeometry = buildShellGeometry();
    const yokeGeometry = buildYokeGeometry();
    const baseGeometry = buildBaseGeometry();
    const materials: BarMaterials = {
      diffuser,
      shell,
      shellGeometry,
      shellFrontZ: measureShellFrontZ(shellGeometry),
      yokeGeometry,
      baseGeometry,
    };

    // One bar per reported row, rather than exactly two. The capability for
    // this model is 2x48 and realistically stays that way, but `placeLeds`'s
    // own comment promises the model follows the layout, and hardcoding the
    // pair made that promise false: at `rows === 1` the second bar's
    // `remapFaceUv` pinned `v = 1.5` and sampled outside the texture entirely.
    // `sideFor` spreads whatever number of bars there are symmetrically about
    // the centre line, so the two-bar case is unchanged (-1 and +1).
    const barCount = Math.max(1, layout.rows);
    const sideFor = (row: number): number =>
      barCount === 1 ? 0 : -1 + (2 * row) / (barCount - 1);
    const bars = Array.from({ length: barCount }, (_, row) =>
      buildBar(row, barCount, layout.cols, sideFor(row), materials),
    );

    const group = new Group();
    group.add(...bars.map((b) => b.group));
    // Emitters are read back through the world matrix, so the whole graph has
    // to be current before placeLeds runs.
    group.updateMatrixWorld(true);

    const leds = placeLeds(layout, bars);

    // Bounding radius about the model's own mid-height, measured from the
    // actual extremes rather than assumed: the outermost point is a base rim
    // at y = 0 on the far side of a toed-in bar, and the highest is a bar's
    // pitched top.
    const halfHeight = TOTAL_HEIGHT / 2;
    const outerX = BAR_HALF_SPACING + BASE_RADIUS;
    const fitRadius = Math.max(
      Math.hypot(outerX, halfHeight),
      Math.hypot(BAR_HALF_SPACING + BAR_WIDTH / 2, TOTAL_HEIGHT - halfHeight),
    );

    let disposed = false;
    return {
      model: "H6056",
      object3D: group,
      leds,
      layout,
      diffusers: bars.map((b) => b.faceMesh),
      slots: { diffuser, shell },
      spill: buildSpill(leds, layout),
      fitRadius,
      height: TOTAL_HEIGHT,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const bar of bars) bar.faceMesh.geometry.dispose();
        shellGeometry.dispose();
        yokeGeometry.dispose();
        baseGeometry.dispose();
        (diffuser as Material).dispose();
        (shell as Material).dispose();
      },
    };
  },
};
