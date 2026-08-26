/**
 * The model registry: resolves a device's `model` string to its
 * `ProceduralSource`, and caches the built `LampModel` per model string so
 * every mounted view of the same hardware shares one geometry and one
 * material set — never one per device.
 *
 * ## Why sharing the whole `LampModel`, not just geometry/materials, is safe
 *
 * `renderer.ts` (a later module) draws one shared `WebGLRenderer` across
 * every mounted view via scissor rectangles, one view at a time, in
 * sequence — never two views in the same draw call. That means a single
 * `object3D` can be reused across three H6056 plates on one dashboard: the
 * renderer sets that view's own LED `DataTexture` onto the shared diffuser
 * material's `emissiveMap` immediately before drawing that view's scissor
 * rect, then moves to the next view and repeats. Nothing about three.js
 * requires a `Mesh` to have only one parent across a whole session — it only
 * requires one parent *at a time*, and this cache is what makes "at a time"
 * true by construction: there is exactly one `LampModel` per model string, so
 * there is exactly one `object3D` to reparent.
 *
 * This is why `acquireModel()` returns the identical `LampModel` — same
 * `object3D`, same `slots` materials — on every call for the same model
 * string, not a clone. Per-view state (the LED texture, spill light colors)
 * lives in the caller, keyed by device id, never here.
 */

import { MeshPhysicalMaterial } from "three";
import type { LampModel, LedLayout, ModelSource, ProceduralSource } from "./types";
import { h6022Source } from "./h6022";
import { h6056Source } from "./h6056";
import { h6008Source } from "./h6008";
import { unknownSource } from "./unknown";

/** The recognized `model` strings, each mapped to the source that builds its
 *  body. The single source of truth `sourceForModel()` and `cacheKey()` both
 *  read from, so a model added to one can never silently diverge from the
 *  other the way two independent switch/lookup tables could. */
const PROCEDURAL_SOURCES: Readonly<Record<string, ProceduralSource>> = {
  H6022: h6022Source,
  H6056: h6056Source,
  H6008: h6008Source,
};

/** Resolves a device's `model` string to the source that builds its body.
 *  `null` and anything unrecognized fall through to the neutral capsule —
 *  the fallback described in `unknown.ts`, not the ledger's "unknown mode". */
export function sourceForModel(model: string | null): ModelSource {
  if (model !== null && model in PROCEDURAL_SOURCES) {
    return PROCEDURAL_SOURCES[model];
  }
  return unknownSource;
}

interface CacheEntry {
  model: LampModel;
  refCount: number;
}

/**
 * Keyed by model string, `""` for the neutral fallback, matching
 * `unknownSource`'s `LampModel.model`. **Every** unrecognized model string
 * shares that one `""` key — two distinct unrecognized strings (a typo'd
 * model, a device type added to the fleet after this file was written) would
 * otherwise each build and hold their own redundant neutral capsule forever,
 * since nothing ever tells them they're interchangeable. `cacheKey()` is what
 * enforces that collapse; `sourceForModel()` alone doesn't (it just returns
 * `unknownSource` for either string without saying they're the *same*
 * capsule).
 *
 * Not exported: production code goes through `acquireModel()`/
 * `releaseModel()` only. Tests that need to inspect or reset cache occupancy
 * use `modelCacheTestHooks` below, a narrow accessor, rather than mutating
 * this `Map` directly — see `models.test.ts`.
 */
const CACHE = new Map<string, CacheEntry>();

function cacheKey(model: string | null): string {
  return model !== null && model in PROCEDURAL_SOURCES ? model : "";
}

/**
 * Test-only window into `CACHE`. Exists so `models.test.ts` can assert on and
 * reset cache occupancy between cases without either exporting the raw
 * mutable `Map` (finding: that invites production code to bypass
 * `acquireModel()`/`releaseModel()`'s refcounting) or duplicating the
 * dispose-and-clear logic inline in every test file that touches this
 * module.
 */
export const modelCacheTestHooks = {
  has(key: string): boolean {
    return CACHE.has(key);
  },
  size(): number {
    return CACHE.size;
  },
  /** Disposes every cached model and empties the cache — the same cleanup
   *  `releaseModel()` performs per-entry, run unconditionally for whatever a
   *  previous test case left behind. */
  reset(): void {
    for (const entry of CACHE.values()) {
      entry.model.dispose();
    }
    CACHE.clear();
  },
};

/**
 * Registers one more view against `model`'s shared `LampModel`, building it
 * on the first call and reusing it — same `object3D`, same materials — on
 * every call after, until every acquisition has a matching `releaseModel()`.
 *
 * `layout` is only consulted on the first (building) call. For the three
 * modeled devices the layout is a fixed property of the hardware (see
 * CLAUDE.md's matrix table), so later callers passing a different layout for
 * an already-cached model would be a real bug upstream — this function does
 * not attempt to reconcile that; it trusts the first caller.
 */
export function acquireModel(model: string | null, layout: LedLayout): LampModel {
  const key = cacheKey(model);
  const existing = CACHE.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.model;
  }

  const source = sourceForModel(model);
  if (source.kind !== "procedural") {
    // No .glb-backed GltfSource is wired up yet (see types.ts); this branch
    // exists so adding one later is a type error here, not a silent no-op.
    throw new Error(`acquireModel: no procedural source registered for model "${key}"`);
  }
  const built = source.build(layout);
  CACHE.set(key, { model: built, refCount: 1 });
  return built;
}

/**
 * Releases one view's hold on `model`'s shared `LampModel`. Disposes and
 * evicts it only once every matching `acquireModel()` call has been
 * released — the refcount the module comment above depends on for safety.
 *
 * Releasing a model that isn't cached (a double-release, or a release
 * without a matching acquire) is a no-op rather than a throw: an unmount
 * path calling this defensively should never be able to turn into a crash.
 */
export function releaseModel(model: string | null): void {
  const key = cacheKey(model);
  const entry = CACHE.get(key);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.model.dispose();
    CACHE.delete(key);
  }
}

/**
 * `transmission` on `MeshPhysicalMaterial` renders a full transmission pass
 * per object — the spec's documented mobile-GPU fallback drops it to 0 for
 * plates and keeps it for the hero. Every model file stashes its authored
 * transmission on `material.userData.baseTransmission` at construction time
 * specifically so this function never has to hardcode or rediscover that
 * number; it only toggles between "authored value" and "off".
 *
 * A model with no diffuser slot (should not happen for any current model,
 * but is not a contract three.js enforces) is a no-op, not a throw.
 */
export function setDiffuserQuality(model: LampModel, tier: "hero" | "plate"): void {
  const diffuser = model.slots.diffuser;
  if (!(diffuser instanceof MeshPhysicalMaterial)) return;

  const base = typeof diffuser.userData.baseTransmission === "number" ? diffuser.userData.baseTransmission : diffuser.transmission;

  diffuser.transmission = tier === "plate" ? 0 : base;
}
