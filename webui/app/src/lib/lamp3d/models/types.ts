/**
 * The contract every lamp model implements, and the one every other module in
 * `lamp3d/` depends on.
 *
 * three.js appears here as a **type-only** import: TypeScript erases it, so
 * `led-field.ts` and its Node-environment vitest suite can import `LedLayout`
 * from this file without ever loading a WebGL runtime. That is what keeps the
 * spec's "pure, GL-free, and unit-testable" promise honest rather than
 * aspirational.
 */

import type * as THREE from "three";

/**
 * The matrix a device's LEDs are addressed on — `matrix_rows`/`matrix_cols`/
 * `matrix_wrap_col` from `Capabilities`, straight off the wire.
 *
 * A model with no addressable matrix (the H6008 bulb) reports 0x0 from the
 * sidecar; `singleEmitterLayout()` turns that into the 1x1 field the render
 * path expects, so nothing downstream needs a "no matrix" branch.
 */
export interface LedLayout {
  rows: number;
  cols: number;
  /** True when the last column physically touches column 0 — the H6022's
   *  drum, where a chase must run continuously around the cylinder rather
   *  than snapping back at a seam. Drives `wrapS = RepeatWrapping` on the
   *  emissive texture and the wrap-aware distance metric in `led-field.ts`. */
  wrapCol: boolean;
}

/** LED count for a layout. The single source of the `leds * 3` buffer length
 *  every caller allocates. */
export function ledCount(layout: LedLayout): number {
  return Math.max(1, layout.rows) * Math.max(1, layout.cols);
}

/** Row-major index, matching the firmware's own `row * cols + col`. */
export function ledIndex(layout: LedLayout, row: number, col: number): number {
  return row * layout.cols + col;
}

/** The 1x1 field a model without an addressable matrix renders from. */
export function singleEmitterLayout(): LedLayout {
  return { rows: 1, cols: 1, wrapCol: false };
}

/**
 * Resolves a device's capabilities into a layout, falling back to a single
 * emitter. `matrix_rows`/`matrix_cols` are 0 on the H6008 and absent entirely
 * on a `DeviceSummary` that predates the field, so both are handled here once.
 */
export function layoutFromCapabilities(
  caps: { matrix_rows?: number; matrix_cols?: number; matrix_wrap_col?: boolean } | null | undefined,
): LedLayout {
  const rows = caps?.matrix_rows ?? 0;
  const cols = caps?.matrix_cols ?? 0;
  if (rows > 0 && cols > 0) {
    return { rows, cols, wrapCol: caps?.matrix_wrap_col === true };
  }
  return singleEmitterLayout();
}

/**
 * One emitter, placed on the body it shines out of.
 *
 * `position`/`normal` are world-space in the model's own units (see
 * `LampModel.fitRadius`). They exist so `cast-light.ts` can average real
 * positions into spill lights — the emission itself is sampled through the
 * diffuser's UVs, not from these.
 */
export interface LedPlacement {
  /** `row * cols + col` — the index into the RGB buffer. */
  index: number;
  row: number;
  col: number;
  position: readonly [number, number, number];
  normal: readonly [number, number, number];
}

/**
 * A cluster of LEDs represented by one real `PointLight` in the scene.
 *
 * 132 shadow-casting lights is not viable, so `cast-light.ts` colours a
 * handful of lights by the mean of the LEDs listed here — cheap, and it still
 * sweeps correctly when a chase runs around the drum, because the clusters
 * partition the matrix spatially rather than being fixed art-directed colours.
 */
export interface SpillCluster {
  position: readonly [number, number, number];
  /** Indices into the LED buffer whose mean colour drives this light. */
  ledIndices: readonly number[];
}

/** Named material roles, so `emission.ts` can find the surfaces that take the
 *  LED texture without knowing any model's internal mesh names. */
export type MaterialSlot = "diffuser" | "shell" | "base" | "metal" | "glass";

export interface LampModel {
  /** "H6022", "H6056", "H6008", or "" for the neutral fallback capsule. */
  model: string;
  /** Everything the scene mounts. Positioned so the body sits on y = 0. */
  object3D: THREE.Group;
  leds: LedPlacement[];
  layout: LedLayout;
  /** The meshes whose material carries `emissiveMap`. One for the H6022 drum
   *  and the H6008 envelope, two for the H6056's bars. */
  diffusers: THREE.Mesh[];
  /** Materials by role, for per-slot roughness/metalness and for disposal. */
  slots: Partial<Record<MaterialSlot, THREE.Material>>;
  spill: SpillCluster[];
  /** Bounding radius used to frame the camera. Set by the model so the hero
   *  and the plate both fit the object without per-call-site tuning. */
  fitRadius: number;
  /** Height of the body, for placing the ground plane and the key light. */
  height: number;
  /** Releases geometries/materials this model owns. Shared caches call this
   *  once, when the last view referencing the model unmounts. */
  dispose(): void;
}

/**
 * How a model is produced. Procedural today; the indirection exists so a
 * measured `.glb` can replace any single model later without the light
 * simulation knowing the difference — the spec's explicit requirement.
 */
export interface ProceduralSource {
  kind: "procedural";
  build(layout: LedLayout): LampModel;
}

export interface GltfSource {
  kind: "gltf";
  url: string;
  /** Mesh names in the `.glb` that carry the LED emission. */
  diffuserNames: string[];
  /** A `.glb` still needs LED placements; the same procedural placer supplies
   *  them, since the emitters are a property of the hardware, not the art. */
  place(layout: LedLayout): LedPlacement[];
}

export type ModelSource = ProceduralSource | GltfSource;
