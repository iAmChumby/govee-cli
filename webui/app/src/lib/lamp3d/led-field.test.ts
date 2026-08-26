/**
 * Tests for `led-field.ts` — the 3D stage's load-bearing seam
 * (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`).
 *
 * Golden values below were produced by running the module itself once at a
 * fixed `(spec, layout, t)` and freezing the result (see the git history for
 * this file if they ever need regenerating) — every golden assertion is
 * paired with a structural assertion that would still catch a regression
 * even if the exact numbers drifted for an unrelated reason (a palette
 * default changing, say).
 *
 * Run with `npx vitest run src/lib/lamp3d/led-field.test.ts` (node env,
 * pure — no DOM, no three.js).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { clearLedField, evaluateLedField, writeEffectFrame } from "./led-field";
import { ledCount, ledIndex, singleEmitterLayout, type LedLayout } from "./models/types";
import type { EffectDescriptor, MotionArchetype, MotionSpec } from "@/lib/motion-engine/types";

const H6022: LedLayout = { rows: 11, cols: 12, wrapCol: true };
const H6022_NO_WRAP: LedLayout = { rows: 11, cols: 12, wrapCol: false };
const H6056: LedLayout = { rows: 2, cols: 48, wrapCol: false };
const H6008 = singleEmitterLayout();

const ALL_ARCHETYPES: MotionArchetype[] = [
  "breathe",
  "blob",
  "plasma",
  "wave",
  "chase",
  "sparkle",
  "flicker",
  "strobe",
  "gradient-drift",
  "rain",
];

function spec(archetype: MotionArchetype, colors: string[], periodSec = 4, intensity = 0.8): MotionSpec {
  return { archetype, palette: { colors }, periodSec, intensity };
}

function triple(out: Uint8ClampedArray, idx: number): [number, number, number] {
  return [out[idx * 3]!, out[idx * 3 + 1]!, out[idx * 3 + 2]!];
}

const RGB3 = ["#ff0000", "#00ff00", "#0000ff"];

/* -------------------------------------------------------- buffer contract */

test("evaluateLedField writes every triple for every layout (buffer length contract)", () => {
  for (const layout of [H6022, H6056, H6008]) {
    const out = new Uint8ClampedArray(ledCount(layout) * 3);
    evaluateLedField(spec("blob", RGB3), layout, 1.23, out);
    assert.equal(out.length, ledCount(layout) * 3);
    // Every archetype must run to completion without leaving any LED
    // untouched — a stray `continue`/early `return` in a per-LED branch
    // would silently leave stale bytes from a previous frame. Proven by
    // seeding the buffer with two different poison fills and requiring the
    // same result either way: if any byte survived from the seed, the two
    // results would differ.
    for (const archetype of ALL_ARCHETYPES) {
      const bufA = new Uint8ClampedArray(ledCount(layout) * 3).fill(170);
      const bufB = new Uint8ClampedArray(ledCount(layout) * 3).fill(43);
      evaluateLedField(spec(archetype, RGB3), layout, 1.23, bufA);
      evaluateLedField(spec(archetype, RGB3), layout, 1.23, bufB);
      assert.deepEqual(Array.from(bufA), Array.from(bufB), `${archetype} on ${layout.rows}x${layout.cols} left part of the buffer untouched`);
    }
  }
});

test("clearLedField zero-fills regardless of prior contents", () => {
  const out = new Uint8ClampedArray(12);
  out.fill(255);
  clearLedField(out);
  assert.ok(out.every((v) => v === 0));
});

/* ------------------------------------------------------------ determinism */

test("two calls at the same t produce identical buffers, for every archetype", () => {
  for (const archetype of ALL_ARCHETYPES) {
    const a = new Uint8ClampedArray(ledCount(H6022) * 3);
    const b = new Uint8ClampedArray(ledCount(H6022) * 3);
    evaluateLedField(spec(archetype, RGB3, 4, 0.8), H6022, 5.5, a);
    evaluateLedField(spec(archetype, RGB3, 4, 0.8), H6022, 5.5, b);
    assert.deepEqual(Array.from(a), Array.from(b), `${archetype} is not deterministic`);
  }
});

/* ------------------------------------------------ no-allocation smoke test */

test("1000 calls into the same buffer do not throw and stay deterministic (caller owns the buffer)", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  const s = spec("plasma", RGB3, 3, 0.9);
  let lastSnapshot: number[] | null = null;
  for (let i = 0; i < 1000; i++) {
    const t = (i % 37) * 0.1; // cycle through a handful of distinct t values
    evaluateLedField(s, H6022, t, out);
    if (t === 0) {
      const snapshot = Array.from(out);
      if (lastSnapshot) assert.deepEqual(snapshot, lastSnapshot, "same t produced a different frame across iterations");
      lastSnapshot = snapshot;
    }
  }
  assert.equal(out.length, ledCount(H6022) * 3);
});

/* ------------------------------------------------------- per-archetype goldens */

test("breathe is uniform across every LED and matches the golden triple", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("breathe", ["#ffb26b"], 4, 0.8), H6022, 3.25, out);
  const golden: [number, number, number] = [188, 131, 79];
  assert.deepEqual(triple(out, 0), golden);
  // Structural: breathe has no positional dependence at all.
  for (let i = 0; i < ledCount(H6022); i++) {
    assert.deepEqual(triple(out, i), golden, `LED ${i} differs from LED 0 under breathe`);
  }
});

test("blob golden values at a fixed spec/t, and a structural soft-multi-lobe property", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("blob", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [0, 0, 0]);
  assert.deepEqual(triple(out, 5), [4, 0, 14]);
  assert.deepEqual(triple(out, 60), [73, 18, 45]);
  assert.deepEqual(triple(out, 131), [0, 0, 0]);
  // Structural: blob is not uniform (it is several soft moving lobes, not a
  // flat wash) — at least one lit LED and at least one dark LED exist.
  const brightness = Array.from({ length: ledCount(H6022) }, (_, i) => triple(out, i).reduce((a, b) => a + b, 0));
  assert.ok(brightness.some((b) => b > 0));
  assert.ok(brightness.some((b) => b === 0));
});

test("plasma golden values — same lobe engine as blob, faster and denser", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("plasma", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [0, 29, 4]);
  assert.deepEqual(triple(out, 5), [0, 83, 69]);
  assert.deepEqual(triple(out, 60), [64, 39, 24]);
  assert.deepEqual(triple(out, 131), [0, 0, 0]);
  // Structural (as blob's above): plasma is several soft moving lobes, not a
  // flat wash — at least one lit LED and at least one dark LED exist. A bug
  // that flattened plasma to a uniform field would slip past the frozen
  // triples above if it happened to preserve those exact four indices.
  const brightness = Array.from({ length: ledCount(H6022) }, (_, i) => triple(out, i).reduce((a, b) => a + b, 0));
  assert.ok(brightness.some((b) => b > 0));
  assert.ok(brightness.some((b) => b === 0));
});

test("gradient-drift golden values sweep smoothly with a rotating axis", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("gradient-drift", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [110, 94, 0]);
  assert.deepEqual(triple(out, 5), [181, 23, 0]);
  assert.deepEqual(triple(out, 60), [0, 126, 78]);
  assert.deepEqual(triple(out, 131), [0, 94, 110]);
  // Structural: a linear gradient sweeping across row 0 must move smoothly
  // from one endpoint colour toward the next — no discontinuity where the
  // gradient parameter should be continuous. A bug that sampled the palette
  // cyclically (wrapping back to the start mid-row) instead of the clamped
  // interpolation `gradient-drift` actually uses would show up as a big
  // backward jump partway across the row; this would slip past the four
  // frozen indices above unless it happened to land on one of them.
  const row0 = Array.from({ length: 12 }, (_, col) => triple(out, ledIndex(H6022, 0, col)));
  for (let col = 1; col < row0.length; col++) {
    const prev = row0[col - 1]!;
    const cur = row0[col]!;
    const step = Math.sqrt(prev.reduce((sum, v, i) => sum + (v - cur[i]!) ** 2, 0));
    assert.ok(step < 40, `row 0 col ${col - 1}->${col} jumped by ${step}, not a smooth sweep`);
  }
});

test("wave defaults to the row axis on a tall matrix (H6022) — same value for every column at a given row", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("wave", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [33, 0, 42]);
  assert.deepEqual(triple(out, 60), [6, 91, 0]);
  assert.deepEqual(triple(out, 120), [66, 0, 84]);
  // Structural: row 10's two ends (col 0 and col 11) must match — wave is
  // row-driven here, so it cannot vary across a row.
  assert.deepEqual(triple(out, 120), triple(out, 131));
});

test("wave falls back to the column axis on a wide-thin bar (H6056) — the 2-row-degeneracy rule", () => {
  const out = new Uint8ClampedArray(ledCount(H6056) * 3);
  evaluateLedField(spec("wave", RGB3, 4, 0.8), H6056, 3.25, out);
  assert.deepEqual(triple(out, 0), [33, 0, 42]);
  assert.deepEqual(triple(out, 47), [66, 0, 84]);
  // Structural: the two rows must be identical at a given column (row axis
  // has no influence once the fallback triggers) — this is exactly the
  // "does not degenerate to a flat two-tone" requirement, verified as "the
  // two tones it does have are actually driven by the column, not the row".
  assert.deepEqual(triple(out, 0), triple(out, 48)); // col 0, row 0 vs row 1
  assert.deepEqual(triple(out, 47), triple(out, 95)); // col 47, row 0 vs row 1
  // And it must vary across columns, or the "fallback" would be a no-op.
  assert.notDeepEqual(triple(out, 0), triple(out, 47));
});

test("sparkle golden values and a structural per-LED independence property", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("sparkle", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [0, 0, 0]);
  assert.deepEqual(triple(out, 5), [0, 0, 0]);
  assert.deepEqual(triple(out, 60), [0, 163, 22]);
  assert.deepEqual(triple(out, 131), [0, 29, 160]);
  // Structural: sparkle is a field of independently twinkling points, so not
  // every LED is lit and not every LED is dark at the same instant.
  const lit = Array.from({ length: ledCount(H6022) }, (_, i) => triple(out, i)).filter((c) => c.some((v) => v > 0));
  assert.ok(lit.length > 0 && lit.length < ledCount(H6022));
});

test("flicker golden values, radially brighter near its low-centred vignette", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("flicker", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [0, 0, 0]);
  assert.deepEqual(triple(out, 60), [22, 0, 15]);
  assert.deepEqual(triple(out, 65), [66, 0, 46]);
  assert.deepEqual(triple(out, 131), [11, 0, 8]);
  // Structural: LED 65 (row 5, col 5 — near the vignette centre) must be
  // brighter than LED 0 (row 0, col 0 — the corner farthest from centre).
  const b0 = triple(out, 0).reduce((a, b) => a + b, 0);
  const b65 = triple(out, 65).reduce((a, b) => a + b, 0);
  assert.ok(b65 > b0);
});

test("strobe is all-zero off-phase and a flat non-zero flash on-phase, uniformly", () => {
  const s = spec("strobe", RGB3, 4, 0.8);
  const onOut = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(s, H6022, 0.01, onOut); // cyclePos = 0.0025 < 0.12 -> on
  assert.deepEqual(triple(onOut, 0), [204, 0, 0]);
  assert.deepEqual(triple(onOut, 60), [204, 0, 0]);
  for (let i = 0; i < ledCount(H6022); i++) assert.deepEqual(triple(onOut, i), [204, 0, 0]);

  const offOut = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(s, H6022, 1.0, offOut); // cyclePos = 0.25 >= 0.12 -> off
  assert.ok(offOut.every((v) => v === 0));
});

test("rain golden values — falling streaks, not every LED lit at once", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("rain", RGB3, 4, 0.8), H6022, 3.25, out);
  assert.deepEqual(triple(out, 0), [0, 0, 0]);
  assert.deepEqual(triple(out, 60), [113, 0, 0]);
  assert.deepEqual(triple(out, 120), [0, 0, 0]);
  assert.deepEqual(triple(out, 131), [0, 0, 0]);
  // Structural: rain is independent falling streaks, one per column, each at
  // its own phase — so no single row should ever show every column lit at
  // once (that would mean every streak's head happened to align, which is
  // not what "falling" independently means), and at least something must be
  // lit somewhere. A bug that lit every column simultaneously (e.g. losing
  // the per-column phase seed) would slip past the four frozen indices above
  // unless it happened to move those exact ones.
  let anyLit = false;
  for (let row = 0; row < H6022.rows; row++) {
    const litCols = Array.from({ length: H6022.cols }, (_, col) => triple(out, ledIndex(H6022, row, col))).filter((c) =>
      c.some((v) => v > 0),
    ).length;
    assert.ok(litCols < H6022.cols, `row ${row} has every column lit at once`);
    if (litCols > 0) anyLit = true;
  }
  assert.ok(anyLit, "rain produced no lit LEDs at all at this t");
});

/* --------------------------------------------------------- wrap correctness */

test("chase forms exactly one contiguous bright region (not scattered noise)", () => {
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(spec("chase", RGB3, 4, 1.0), H6022, 3.25, out);
  const colBrightness = Array.from({ length: 12 }, (_, col) => triple(out, ledIndex(H6022, 0, col)).reduce((a, b) => a + b, 0));
  const litCols = colBrightness.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(litCols, [7, 8, 9]); // golden: contiguous run of columns
  // Structural: the lit columns are consecutive.
  for (let i = 1; i < litCols.length; i++) assert.equal(litCols[i], litCols[i - 1]! + 1);
  // Structural: chase lights the whole column, uniformly across rows.
  for (const col of litCols) {
    const row0 = triple(out, ledIndex(H6022, 0, col));
    const row5 = triple(out, ledIndex(H6022, 5, col));
    assert.deepEqual(row0, row5, `chase should light column ${col} uniformly across rows`);
  }
});

test("H6022 wrap: chase's head at u=0 lights col 11 and col 0 to the same level — the seam is continuous", () => {
  const s = spec("chase", RGB3, 4, 1.0);
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  evaluateLedField(s, H6022, 8 /* progress = frac(8/4) = 0 exactly */, out);
  const col0 = triple(out, 0);
  const col6 = triple(out, 6);
  const col11 = triple(out, 11);

  assert.deepEqual(col0, [235, 0, 20]);
  assert.deepEqual(col6, [0, 0, 0]);
  assert.deepEqual(col11, [235, 0, 20]);

  const dist = (a: [number, number, number], b: [number, number, number]) =>
    Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0));
  const seamGap = dist(col0, col11);
  const midGap = dist(col0, col6);
  assert.equal(seamGap, 0);
  assert.ok(seamGap < midGap * 0.05, `seam gap ${seamGap} should be small relative to the col0-col6 gap ${midGap}`);
});

test("H6022 wrap DISABLED: the same chase does NOT read continuously across the seam — the flag is load-bearing", () => {
  const s = spec("chase", RGB3, 4, 1.0);
  const out = new Uint8ClampedArray(ledCount(H6022_NO_WRAP) * 3);
  evaluateLedField(s, H6022_NO_WRAP, 8, out);
  const col0 = triple(out, 0);
  const col11 = triple(out, 11);

  assert.deepEqual(col0, [255, 0, 0]);
  assert.deepEqual(col11, [209, 0, 20]);

  const dist = (a: [number, number, number], b: [number, number, number]) =>
    Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0));
  // With wrapCol true the seam gap was exactly 0; with it false there must
  // be a real, non-trivial gap — proving the flag actually changes behavior
  // rather than being read and ignored.
  assert.ok(dist(col0, col11) > 20);
});

/* ----------------------------------------------------------- writeEffectFrame */

function makeEffect(): EffectDescriptor {
  // Two keyframes per segment (both the same color) so `totalDurationMs` is
  // non-zero and `frameAt` actually produces a frame — a single t=0
  // keyframe alone yields an empty frame by `effect-playback.ts` design.
  return {
    fps: 10,
    loop: true,
    startedAt: 0,
    segments: [
      { id: 0, keyframes: [{ t: 0, color: "#ff0000" }, { t: 1000, color: "#ff0000" }] },
      { id: 1, keyframes: [{ t: 0, color: "#00ff00" }, { t: 1000, color: "#00ff00" }] },
      { id: 2, keyframes: [{ t: 0, color: "#0000ff" }, { t: 1000, color: "#0000ff" }] },
    ],
  };
}

test("writeEffectFrame spreads segments across columns on the H6022 matrix", () => {
  const effect = makeEffect();
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  writeEffectFrame(effect, H6022, 500, out);
  assert.deepEqual(triple(out, ledIndex(H6022, 0, 0)), [255, 0, 0]);
  assert.deepEqual(triple(out, ledIndex(H6022, 0, 5)), [0, 255, 0]);
  assert.deepEqual(triple(out, ledIndex(H6022, 0, 11)), [0, 0, 255]);
  // Every row in a column carries that column's segment colour.
  assert.deepEqual(triple(out, ledIndex(H6022, 0, 0)), triple(out, ledIndex(H6022, 10, 0)));
});

test("writeEffectFrame spreads segments across columns on the H6056 (2x48) bars", () => {
  const effect = makeEffect();
  const out = new Uint8ClampedArray(ledCount(H6056) * 3);
  writeEffectFrame(effect, H6056, 500, out);
  assert.deepEqual(triple(out, ledIndex(H6056, 0, 0)), [255, 0, 0]);
  assert.deepEqual(triple(out, ledIndex(H6056, 0, 24)), [0, 255, 0]);
  assert.deepEqual(triple(out, ledIndex(H6056, 0, 47)), [0, 0, 255]);
  // Both bars (rows) show the same colour at a given column.
  assert.deepEqual(triple(out, ledIndex(H6056, 0, 24)), triple(out, ledIndex(H6056, 1, 24)));
});

test("writeEffectFrame on a 1x1 (H6008) single emitter shows the lowest-id segment's colour", () => {
  const effect = makeEffect();
  const out = new Uint8ClampedArray(ledCount(H6008) * 3);
  writeEffectFrame(effect, H6008, 500, out);
  assert.deepEqual(triple(out, 0), [255, 0, 0]);
});

test("writeEffectFrame clears the field when the effect has no playable duration", () => {
  const degenerate: EffectDescriptor = {
    fps: 10,
    loop: true,
    startedAt: 0,
    segments: [{ id: 0, keyframes: [{ t: 0, color: "#ff0000" }] }], // single keyframe -> total duration 0
  };
  const out = new Uint8ClampedArray(ledCount(H6022) * 3);
  out.fill(255);
  writeEffectFrame(degenerate, H6022, 500, out);
  assert.ok(out.every((v) => v === 0));
});
