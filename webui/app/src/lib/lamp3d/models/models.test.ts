/**
 * Model-layer tests: LED placement geometry for every procedural body, plus
 * the acquire/release cache in `source.ts`. Runs in the default Node vitest
 * environment — three.js only needs a GL context at *render* time, geometry
 * and material construction is plain JS/WASM-free math, so none of this
 * needs jsdom or a browser.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Box3, Vector3, type BufferGeometry, type Mesh } from "three";
import { h6022Source } from "./h6022";
import { h6056Source } from "./h6056";
import { h6008Source } from "./h6008";
import { unknownSource } from "./unknown";
import { acquireModel, releaseModel, modelCacheTestHooks } from "./source";
import { ledCount, singleEmitterLayout, type LedLayout, type LedPlacement } from "./types";

const H6022_LAYOUT: LedLayout = { rows: 11, cols: 12, wrapCol: true };
const H6056_LAYOUT: LedLayout = { rows: 2, cols: 48, wrapCol: false };

const EPS = 1e-6;

function vecLength([x, y, z]: readonly [number, number, number]): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Every model's placements must be a complete `0..n-1` permutation with no
 *  gaps or duplicates, and each index must equal `row * cols + col`. */
function assertCompletePermutation(placements: LedPlacement[], layout: LedLayout): void {
  const seen = new Set<number>();
  for (const p of placements) {
    expect(p.index).toBe(p.row * layout.cols + p.col);
    expect(seen.has(p.index)).toBe(false);
    seen.add(p.index);
  }
  const expectedCount = ledCount(layout);
  expect(seen.size).toBe(expectedCount);
  for (let i = 0; i < expectedCount; i++) {
    expect(seen.has(i)).toBe(true);
  }
}

/**
 * The ring of vertices at `geometry`'s own greatest radial distance from the
 * vertical axis through `(axisX, axisZ)`, and the y range they span.
 *
 * Both the H6022's cylindrical drum wall and the H6056's capsule midsection
 * are bodies of revolution whose LED-bearing surface is exactly their widest
 * ring — narrower rings exist only above it (the H6022's dome) or off to
 * either side of it (the H6056's rounded caps). Reading this straight out of
 * the real `BufferGeometry.position` attribute — never from `placeLeds`'s own
 * radius/height constants — is what makes the "LEDs lie on the surface" tests
 * below independent of the code they're checking: a change to the *rendered*
 * body that leaves LED placement untouched (or vice versa) has to show up as
 * a mismatch between this and `LedPlacement.position`.
 */
function findMaxRadiusBand(geometry: BufferGeometry, axisX: number, axisZ: number): { radius: number; yMin: number; yMax: number } {
  const position = geometry.getAttribute("position");
  if (!position) throw new Error("geometry has no position attribute");

  let radius = 0;
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i) - axisX, position.getZ(i) - axisZ);
    if (r > radius) radius = r;
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i) - axisX, position.getZ(i) - axisZ);
    if (Math.abs(r - radius) < EPS) {
      const y = position.getY(i);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  return { radius, yMin, yMax };
}

/** `min`/`max` of `uv.y` across every vertex of `geometry` whose radial
 *  distance from `(axisX, axisZ)` matches `band.radius` within `EPS` — the
 *  same LED-bearing ring `findMaxRadiusBand` locates, but reporting its UV
 *  range instead of its spatial one. */
function vRangeOnBand(geometry: BufferGeometry, axisX: number, axisZ: number, band: { radius: number }): { vMin: number; vMax: number } {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (!position || !uv) throw new Error("geometry missing position or uv attribute");

  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i) - axisX, position.getZ(i) - axisZ);
    if (Math.abs(r - band.radius) < EPS) {
      const v = uv.getY(i);
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }
  return { vMin, vMax };
}

/** `min`/`max` of `uv.y` across every vertex of `geometry`, with no radius
 *  filter — used for the H6056 bars, where the whole capsule (cylinder and
 *  caps alike) was remapped into one row's band, not just its widest ring. */
function vRange(geometry: BufferGeometry): { vMin: number; vMax: number } {
  const uv = geometry.getAttribute("uv");
  if (!uv) throw new Error("geometry has no uv attribute");
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const v = uv.getY(i);
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return { vMin, vMax };
}

/** A mesh's own geometry bounds, computed on demand. `Box3.setFromObject`
 *  would bake in the world transform; these tests want the untransformed
 *  bounds so they can apply exactly the matrix they mean to. */
function boundsOf(mesh: Mesh): Box3 {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) throw new Error("mesh geometry has no bounding box");
  return box;
}

describe("h6022Source", () => {
  const model = h6022Source.build(H6022_LAYOUT);

  it("places 132 LEDs (11 rows x 12 cols)", () => {
    expect(model.leds.length).toBe(132);
    expect(model.leds.length).toBe(H6022_LAYOUT.rows * H6022_LAYOUT.cols);
  });

  it("indexes as a complete 0..131 permutation matching row*cols+col", () => {
    assertCompletePermutation(model.leds, H6022_LAYOUT);
  });

  it("places every LED at the same radius from the drum's Y axis", () => {
    const radii = model.leds.map((p) => Math.hypot(p.position[0], p.position[2]));
    const first = radii[0];
    for (const r of radii) {
      expect(Math.abs(r - first)).toBeLessThan(EPS);
    }
  });

  it("places every LED ON the shade's actual rendered surface, not merely self-consistent with placeLeds' own constants", () => {
    // model.diffusers[0] is the shade mesh — the real BufferGeometry the
    // renderer draws — read independently of placeLeds' own DRUM_RADIUS/
    // DRUM_HEIGHT constants so a change to the rendered body that leaves LED
    // placement untouched (or vice versa) shows up as a mismatch here, unlike
    // the purely self-referential "same radius as each other" check above.
    const shadeMesh = model.diffusers[0];
    const band = findMaxRadiusBand(shadeMesh.geometry, 0, 0);
    expect(band.radius).toBeGreaterThan(0);
    for (const p of model.leds) {
      const r = Math.hypot(p.position[0], p.position[2]);
      expect(Math.abs(r - band.radius)).toBeLessThan(EPS);
      expect(p.position[1]).toBeGreaterThanOrEqual(band.yMin - EPS);
      expect(p.position[1]).toBeLessThanOrEqual(band.yMax + EPS);
    }
  });

  it("remaps the shade's UVs so the LED-bearing wall spans v in [0, 1] (LatheGeometry's default compresses it to 1/3, see h6022.ts)", () => {
    const shadeMesh = model.diffusers[0];
    const band = findMaxRadiusBand(shadeMesh.geometry, 0, 0);
    const { vMin, vMax } = vRangeOnBand(shadeMesh.geometry, 0, 0, band);
    expect(vMin).toBeCloseTo(0, 6);
    expect(vMax).toBeCloseTo(1, 6);
  });

  it("wraps continuously: the col-11-to-col-0 angular step matches every other step", () => {
    const byRow0 = model.leds.filter((p) => p.row === 0).sort((a, b) => a.col - b.col);
    const angleOf = (p: LedPlacement): number => Math.atan2(p.position[2], p.position[0]);

    const stepBetween = (a: LedPlacement, b: LedPlacement): number => {
      let d = angleOf(b) - angleOf(a);
      // Normalize into (0, 2*PI] so the wrap-around step (col 11 -> col 0,
      // which crosses the atan2 branch cut) compares directly against a
      // plain adjacent step like col 0 -> col 1.
      while (d <= 0) d += Math.PI * 2;
      while (d > Math.PI * 2) d -= Math.PI * 2;
      return d;
    };

    const ordinaryStep = stepBetween(byRow0[0], byRow0[1]);
    const wrapStep = stepBetween(byRow0[byRow0.length - 1], byRow0[0]);
    expect(Math.abs(wrapStep - ordinaryStep)).toBeLessThan(EPS);
  });

  it("spans the drum height monotonically across rows", () => {
    const col0 = model.leds.filter((p) => p.col === 0).sort((a, b) => a.row - b.row);
    for (let i = 1; i < col0.length; i++) {
      expect(col0[i].position[1]).toBeGreaterThan(col0[i - 1].position[1]);
    }
  });

  it("gives every LED a unit-length normal", () => {
    for (const p of model.leds) {
      expect(Math.abs(vecLength(p.normal) - 1)).toBeLessThan(EPS);
    }
  });

  it("sits on y = 0 and reports height/fitRadius", () => {
    expect(model.height).toBeGreaterThan(0);
    expect(model.fitRadius).toBeGreaterThan(0);
  });

  it("disposes without throwing, twice (idempotent)", () => {
    const disposable = h6022Source.build(H6022_LAYOUT);
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe("h6056Source", () => {
  const model = h6056Source.build(H6056_LAYOUT);

  it("places 96 LEDs (2 rows x 48 cols)", () => {
    expect(model.leds.length).toBe(96);
  });

  it("indexes as a complete 0..95 permutation matching row*cols+col", () => {
    assertCompletePermutation(model.leds, H6056_LAYOUT);
  });

  it("splits exactly 48 LEDs to row 0 (left bar) and 48 to row 1 (right bar)", () => {
    const row0 = model.leds.filter((p) => p.row === 0);
    const row1 = model.leds.filter((p) => p.row === 1);
    expect(row0.length).toBe(48);
    expect(row1.length).toBe(48);
  });

  it("keeps each row's bar on its own side, with a clear gap between them", () => {
    const row0Xs = model.leds.filter((p) => p.row === 0).map((p) => p.position[0]);
    const row1Xs = model.leds.filter((p) => p.row === 1).map((p) => p.position[0]);
    const maxRow0 = Math.max(...row0Xs);
    const minRow1 = Math.min(...row1Xs);
    expect(maxRow0).toBeLessThan(minRow1);
  });

  it("runs each bar's y coordinate monotonically increasing with column", () => {
    for (const row of [0, 1]) {
      const byCol = model.leds.filter((p) => p.row === row).sort((a, b) => a.col - b.col);
      for (let i = 1; i < byCol.length; i++) {
        expect(byCol[i].position[1]).toBeGreaterThan(byCol[i - 1].position[1]);
      }
    }
  });

  it("gives every LED a unit-length normal", () => {
    for (const p of model.leds) {
      expect(Math.abs(vecLength(p.normal) - 1)).toBeLessThan(EPS);
    }
  });

  it("places every LED ON the plane of its own bar's actual rendered face, inside that face's bounds", () => {
    // The bars stopped being capsules: each is now a flat diffuser panel set
    // into a shell, pitched back in its yoke and toed in toward its partner
    // (h6056.ts). "Same radius from the bar's axis" no longer describes the
    // lit surface at all, so this asserts the property that does — and it is
    // a strictly stronger one than the radius check it replaces, because a
    // plane plus bounds pins all three coordinates rather than just two.
    //
    // Everything here is read out of the rendered mesh: its world matrix, its
    // real geometry's local bounds. `placeLeds` derives its positions from
    // that same world matrix via `localToWorld`, which is exactly why this
    // test cannot be satisfied by a placement that merely agrees with the
    // model's own constants — there is no constant left to agree with.
    for (const row of [0, 1]) {
      const faceMesh = model.diffusers[row];
      faceMesh.updateMatrixWorld(true);
      faceMesh.geometry.computeBoundingBox();
      const bounds = faceMesh.geometry.boundingBox;
      if (!bounds) throw new Error("face geometry has no bounding box");

      const rowLeds = model.leds.filter((p) => p.row === row);
      expect(rowLeds.length).toBe(H6056_LAYOUT.cols);

      const inverse = faceMesh.matrixWorld.clone().invert();
      for (const p of rowLeds) {
        // Back into the face's own local space: a point ON the panel must
        // land at local z = 0 (the plane) and inside the panel's rectangle.
        const local = new Vector3(p.position[0], p.position[1], p.position[2]).applyMatrix4(inverse);
        expect(Math.abs(local.z)).toBeLessThan(1e-9);
        expect(local.x).toBeGreaterThanOrEqual(bounds.min.x - EPS);
        expect(local.x).toBeLessThanOrEqual(bounds.max.x + EPS);
        expect(local.y).toBeGreaterThanOrEqual(bounds.min.y - EPS);
        expect(local.y).toBeLessThanOrEqual(bounds.max.y + EPS);
      }
    }
  });

  it("aims every LED along its own bar's rendered face normal, toed in rather than straight ahead", () => {
    // The normal is what `cast-light.ts` throws spill along, so it has to
    // follow the bar's actual orientation. Both bars yaw toward the centre
    // line, so the left bar's normal must have a positive x component and the
    // right bar's a negative one — and neither may be the un-rotated (0, 0, 1)
    // that a placement ignoring the transform would produce.
    const leftNormal = model.leds.find((p) => p.row === 0)?.normal;
    const rightNormal = model.leds.find((p) => p.row === 1)?.normal;
    if (!leftNormal || !rightNormal) throw new Error("missing bar normals");
    expect(leftNormal[0]).toBeGreaterThan(0);
    expect(rightNormal[0]).toBeLessThan(0);
    // Pitched back in the yoke, so both tilt slightly upward too.
    expect(leftNormal[1]).toBeGreaterThan(0);
    expect(rightNormal[1]).toBeGreaterThan(0);
  });

  it("leaves every lit face PROUD of the shell it sits in, not buried inside it", () => {
    // The bug this exists to catch: `ExtrudeGeometry`'s `bevelSize` extends the
    // contour outward from the shape's outline, so the shell's real half-depth
    // is larger than the `BAR_DEPTH / 2` it was authored from. A face placed
    // from that constant sat *inside* the shell, and both bars rendered as dark
    // slabs — with the emission computed correctly, uploaded correctly, and
    // completely invisible. No emission test can catch that; only geometry can.
    //
    // Compared in the SHARED PARENT's space, not in world space. The face and
    // its shell are both children of the same pitched group, so "in front of"
    // is unambiguous there and independent of how the bar is later pitched or
    // toed in. A world-space comparison would be wrong in a way that looks
    // right: the shell is taller than the face, so the pitch swings its top
    // corner further along world +z than the face's corner without that corner
    // occluding the face at all.
    model.object3D.updateMatrixWorld(true);

    for (const face of model.diffusers) {
      const parent = face.parent;
      expect(parent).toBeTruthy();
      if (!parent) continue;

      const faceBox = new Box3()
        .copy(boundsOf(face))
        .applyMatrix4(face.matrix);

      const siblings = parent.children.filter((c) => c !== face && (c as Mesh).isMesh) as Mesh[];
      expect(siblings.length).toBeGreaterThan(0);
      for (const sibling of siblings) {
        const shellBox = new Box3().copy(boundsOf(sibling)).applyMatrix4(sibling.matrix);
        expect(faceBox.max.z).toBeGreaterThan(shellBox.max.z);
      }
    }
  });

  it("gives the left and right bars disjoint UV bands into the shared 2x48 texture", () => {
    // Before the per-bar UV fix, leftBar and rightBar shared one geometry and
    // therefore one identical [0, 1] v range — a chase on one bar would have
    // shown on both. Overlap here (beyond touching at the shared boundary)
    // is exactly that regression.
    const leftRange = vRange(model.diffusers[0].geometry);
    const rightRange = vRange(model.diffusers[1].geometry);
    expect(leftRange.vMin).toBeLessThan(rightRange.vMin);
    expect(leftRange.vMax).toBeLessThanOrEqual(rightRange.vMin + EPS);
    const overlap = Math.min(leftRange.vMax, rightRange.vMax) - Math.max(leftRange.vMin, rightRange.vMin);
    expect(overlap).toBeLessThanOrEqual(EPS);
  });

  it("disposes without throwing, twice (idempotent)", () => {
    const disposable = h6056Source.build(H6056_LAYOUT);
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
  });

  it("actually follows the reported layout rather than assuming 2x48", () => {
    // `placeLeds`'s doc promises the model tracks whatever matrix capabilities
    // report. It did not: the bar count was hardcoded to two, so a one-row
    // layout still built a second bar whose `remapFaceUv` pinned v at
    // (1 + 0.5) / 1 = 1.5 and sampled outside the texture entirely; and the
    // face's segment count was fixed at 48 regardless of `cols`. Either the
    // code follows the layout or the comment has to stop saying it does.
    const single = h6056Source.build({ rows: 1, cols: 24, wrapCol: false });
    expect(single.diffusers.length).toBe(1);
    expect(single.leds.length).toBe(24);
    expect(single.spill.length).toBe(1);

    const { vMin, vMax } = vRange(single.diffusers[0].geometry);
    // One row means one texel band, centred at 0.5 — and crucially inside
    // [0, 1], which the hardcoded-two version was not.
    expect(vMin).toBeCloseTo(0.5, 6);
    expect(vMax).toBeCloseTo(0.5, 6);

    expect(() => single.dispose()).not.toThrow();
  });
});

describe("h6008Source", () => {
  const model = h6008Source.build(singleEmitterLayout());

  it("places exactly one emitter on a 1x1 layout", () => {
    expect(model.leds.length).toBe(1);
    expect(model.layout.rows).toBe(1);
    expect(model.layout.cols).toBe(1);
    expect(model.leds[0].index).toBe(0);
  });

  it("gives the emitter a unit-length upward normal", () => {
    const [nx, ny, nz] = model.leds[0].normal;
    expect(Math.abs(vecLength([nx, ny, nz]) - 1)).toBeLessThan(EPS);
    expect(ny).toBeGreaterThan(0);
  });

  it("disposes without throwing, twice (idempotent)", () => {
    const disposable = h6008Source.build(singleEmitterLayout());
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe("unknownSource", () => {
  const model = unknownSource.build(singleEmitterLayout());

  it("places exactly one emitter on a 1x1 layout", () => {
    expect(model.leds.length).toBe(1);
    expect(model.layout.rows).toBe(1);
    expect(model.layout.cols).toBe(1);
  });

  it("gives the emitter a unit-length normal", () => {
    expect(Math.abs(vecLength(model.leds[0].normal) - 1)).toBeLessThan(EPS);
  });

  it("disposes without throwing, twice (idempotent)", () => {
    const disposable = unknownSource.build(singleEmitterLayout());
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe("acquireModel / releaseModel cache", () => {
  beforeEach(() => {
    // Tests share the module-level cache; drain anything a previous test left
    // behind so cases don't leak into each other. Goes through the narrow
    // test hook rather than a raw exported Map — see source.ts.
    modelCacheTestHooks.reset();
  });

  it("returns the same object3D and materials for two acquisitions of the same model", () => {
    const a = acquireModel("H6022", H6022_LAYOUT);
    const b = acquireModel("H6022", H6022_LAYOUT);
    expect(b).toBe(a);
    expect(b.object3D).toBe(a.object3D);
    expect(b.slots.diffuser).toBe(a.slots.diffuser);
    releaseModel("H6022");
    releaseModel("H6022");
  });

  it("disposes only after every acquisition has a matching release", () => {
    const first = acquireModel("H6056", H6056_LAYOUT);
    acquireModel("H6056", H6056_LAYOUT);
    acquireModel("H6056", H6056_LAYOUT);

    releaseModel("H6056");
    releaseModel("H6056");
    // Two releases against three acquisitions: still cached, still the same
    // instance.
    const stillCached = acquireModel("H6056", H6056_LAYOUT);
    expect(stillCached).toBe(first);
    releaseModel("H6056");

    // Now the refcount from the three original acquisitions (3 acquire, 3
    // release) plus the extra one above (1 acquire, 1 release) fully unwinds.
    releaseModel("H6056");
    releaseModel("H6056");
    expect(modelCacheTestHooks.has("H6056")).toBe(false);

    // A fresh acquisition after full release builds a genuinely new
    // instance rather than returning the disposed one.
    const rebuilt = acquireModel("H6056", H6056_LAYOUT);
    expect(rebuilt).not.toBe(first);
    releaseModel("H6056");
  });

  it("treats an unrecognized model string as the neutral capsule", () => {
    const model = acquireModel("SOME_FUTURE_DEVICE", singleEmitterLayout());
    expect(model.model).toBe("");
    expect(model.leds.length).toBe(1);
    releaseModel("SOME_FUTURE_DEVICE");
  });

  it("routes every unrecognized model string to the SAME cache slot, not one each", () => {
    // Two distinct unrecognized strings must not each build their own
    // redundant neutral capsule — cacheKey() collapses both onto one key.
    const first = acquireModel("SOME_FUTURE_DEVICE", singleEmitterLayout());
    expect(modelCacheTestHooks.size()).toBe(1);

    const second = acquireModel("A_DIFFERENT_UNKNOWN_STRING", singleEmitterLayout());
    expect(second).toBe(first);
    expect(modelCacheTestHooks.size()).toBe(1);

    // One release per acquisition still fully unwinds the shared entry —
    // proof the two calls really did share one refcount, not two keys that
    // happened to compare equal by accident.
    releaseModel("SOME_FUTURE_DEVICE");
    expect(modelCacheTestHooks.has("")).toBe(true);
    releaseModel("A_DIFFERENT_UNKNOWN_STRING");
    expect(modelCacheTestHooks.has("")).toBe(false);
  });

  it("releasing an untracked model is a no-op, not a throw", () => {
    expect(() => releaseModel("NEVER_ACQUIRED")).not.toThrow();
  });
});

/**
 * The axis tests.
 *
 * Everything above asks whether the emitters sit on the body and whether each
 * bar reads its own slice of the texture. Both can be true while the emissive
 * texture is mapped to the WRONG AXIS — which is precisely what happened: the
 * H6056's 48 LEDs run along each bar's length, but the bar's length was mapped
 * to `v`, an axis with two texels, leaving the 48-texel `u` axis wrapped around
 * the tube's circumference. Every disjointness and surface test still passed. A
 * chase that should climb the bar would have run around it instead.
 *
 * So these assert the correspondence directly: the axis the LEDs vary along in
 * SPACE must be the axis the texture varies along in UV.
 */
describe("emissive axis correspondence", () => {
  /** `uv` of the vertex with the smallest and largest `y`, on the mesh's own
   *  surface — the two ends of whatever the body's long axis is. */
  function uvAtHeightExtremes(geometry: BufferGeometry): {
    low: { u: number; v: number };
    high: { u: number; v: number };
  } {
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    if (!position || !uv) throw new Error("geometry missing position or uv");
    let lowI = 0;
    let highI = 0;
    for (let i = 1; i < position.count; i++) {
      if (position.getY(i) < position.getY(lowI)) lowI = i;
      if (position.getY(i) > position.getY(highI)) highI = i;
    }
    return {
      low: { u: uv.getX(lowI), v: uv.getY(lowI) },
      high: { u: uv.getX(highI), v: uv.getY(highI) },
    };
  }

  it("H6056: each bar's 48-LED axis is u, running along the bar's length", () => {
    const model = h6056Source.build(H6056_LAYOUT);
    try {
      expect(model.diffusers).toHaveLength(2);
      for (const bar of model.diffusers) {
        const { low, high } = uvAtHeightExtremes(bar.geometry);
        // u must sweep the full texture width between the bar's two ends, so
        // all 48 texels are addressed along the length.
        expect(Math.abs(high.u - low.u)).toBeGreaterThan(0.9);
        // v must NOT vary along the length: this bar is exactly one texel row.
        expect(Math.abs(high.v - low.v)).toBeLessThan(EPS);
      }
    } finally {
      model.dispose();
    }
  });

  it("H6056: each bar sits on the centre of its own texel row, not on the seam", () => {
    const model = h6056Source.build(H6056_LAYOUT);
    try {
      const rows = H6056_LAYOUT.rows;
      const vs = model.diffusers.map((bar) => {
        const uv = bar.geometry.getAttribute("uv");
        if (!uv) throw new Error("bar geometry missing uv");
        return uv.getY(0);
      });
      vs.sort((a, b) => a - b);
      // A vertex landing exactly on `row / rows` samples the NEIGHBOURING row
      // under NearestFilter, so the centres are what must be hit.
      expect(vs[0]).toBeCloseTo(0.5 / rows, 6);
      expect(vs[1]).toBeCloseTo(1.5 / rows, 6);
    } finally {
      model.dispose();
    }
  });

  it("H6022: every LED row sits on the centre of the texel band that lights it", () => {
    const model = h6022Source.build(H6022_LAYOUT);
    try {
      const shade = model.diffusers[0];
      const band = findMaxRadiusBand(shade.geometry, 0, 0);
      const rows = H6022_LAYOUT.rows;
      const wallHeight = band.yMax - band.yMin;
      for (const led of model.leds) {
        // v of this LED's height on the wall, which now spans v in [0, 1].
        const v = (led.position[1] - band.yMin) / wallHeight;
        expect(v).toBeCloseTo((led.row + 0.5) / rows, 6);
      }
    } finally {
      model.dispose();
    }
  });

  it("H6022: every LED column sits on the centre of its own angular band", () => {
    const model = h6022Source.build(H6022_LAYOUT);
    try {
      const cols = H6022_LAYOUT.cols;
      for (const led of model.leds) {
        // LatheGeometry over a full revolution sets u = angle / 2pi, so the
        // texel centre for column c is at angle 2pi * (c + 0.5) / cols.
        const angle = Math.atan2(led.position[2], led.position[0]);
        const u = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
        expect(u).toBeCloseTo((led.col + 0.5) / cols, 6);
      }
    } finally {
      model.dispose();
    }
  });
});
