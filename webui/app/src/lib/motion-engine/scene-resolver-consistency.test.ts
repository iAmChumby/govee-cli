/**
 * The single-resolver proof for consensus item #35.
 *
 * The claim under test: **the card gradient and the 3D stage render the same
 * colour for the same scene name, by construction** — because both go
 * through `motion-engine/scene-appearance.ts`'s curated table and the one
 * resolver built on it (`motion-engine/classify.ts`).
 *
 * The bug this file exists to keep dead (CLAUDE.md, "Two fabrications will
 * not agree, and that is the tell"): `nameToGradient` used to hash the name
 * with FNV-1a into an HSL pair while the stage hashed the same name with
 * `sum(charCode) % 4` into an archetype bucket. Two independent guesses, two
 * independent palettes, and they disagreed — "Aurora" thumbed magenta while
 * the stage rendered the lava-orange palette, and neither was the green/cyan
 * the real lamp shows running Aurora.
 *
 * The second half of the file covers the other end of the honesty axis: a
 * name with no signal at all must render as the neutral INDETERMINATE grey
 * everywhere, and exposure normalization must not lift that grey into a
 * *bright white lamp* — a state the hardware really can be in, which would
 * turn "unknown" into a claim (CLAUDE.md, "`frameNormalizeGain` must not
 * touch the indeterminate palette").
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { nameToGradient } from "@/components/panels/shared";
import { resolveByName, resolveNamedPalette } from "./classify";
import { evaluateLedField } from "@/lib/lamp3d/led-field";
import { createLedTexture, uploadLedFrame } from "@/lib/lamp3d/emission";
import { INDETERMINATE_PALETTE } from "./palette";
import { CURATED_SCENE_NAMES } from "./scene-appearance";
import type { LedLayout } from "@/lib/lamp3d/models/types";

/** The H6022's real matrix — the device the app is most often looking at. */
const H6022: LedLayout = { rows: 11, cols: 12, wrapCol: true };

/**
 * The colour stops out of a `nameToGradient` string, lowercased.
 * `nameToGradient` always emits at least two stops (a single-stop palette
 * is duplicated so the gradient has two ends), so a length-1 palette and its
 * gradient differ in stop count — which is exactly what this function
 * exposes.
 */
function gradientStops(gradient: string): string[] {
  const match = gradient.match(/linear-gradient\([^,]+,\s*(.+)\)$/);
  assert.ok(match, `not a gradient string: ${gradient}`);
  return match![1]!.split(",").map((stop) => stop.trim().toLowerCase());
}

/**
 * The stage's own answer for a name: what `classify.ts` hands the 3D
 * renderer. This is the path the card must agree with.
 */
function stagePalette(name: string): string[] {
  const resolved = resolveNamedPalette(name);
  const colors = resolved.indeterminate
    ? INDETERMINATE_PALETTE.colors
    : resolved.palette.colors;
  return colors.map((c) => c.toLowerCase());
}

/**
 * One scene per archetype, each one a name the curated table actually
 * covers — plus one signal-free name (a user-authored DIY name, the common
 * real case) that must land on the INDETERMINATE grey.
 *
 * The table's own archetype is what each representative is here to prove:
 * every archetype the renderer can draw must agree between card and stage.
 */
const ARCHETYPE_REPRESENTATIVES: ReadonlyArray<{ archetype: string; name: string }> = [
  { archetype: "gradient-drift", name: "Sunrise" },
  { archetype: "chase", name: "Rainbow" },
  { archetype: "blob", name: "Aurora" },
  { archetype: "wave", name: "Ocean" },
  { archetype: "sparkle", name: "Snowflake" },
  { archetype: "flicker", name: "Fire" },
  { archetype: "rain", name: "Waterfall" },
  { archetype: "breathe", name: "Breathe" },
  { archetype: "plasma", name: "Energetic" },
  { archetype: "strobe", name: "Siren" },
];

/** A user-authored DIY name with no curated row, no keyword and no colour
 *  word: the case the honesty axis exists for. */
const SIGNAL_FREE_NAME = "madisonnnn";

describe("#35 card gradient === stage palette", () => {
  for (const rep of ARCHETYPE_REPRESENTATIVES) {
    test(`${rep.name} (${rep.archetype}): the card's gradient stops are the stage's palette`, () => {
      const card = gradientStops(nameToGradient(rep.name));
      const stage = stagePalette(rep.name);

      // The stage's palette, verbatim, in the card's gradient.
      const expected = stage.length > 1 ? stage : [stage[0]!, stage[0]!];
      assert.deepEqual(
        card,
        expected,
        `card gradient for "${rep.name}" is not the stage palette`,
      );

      // And the archetype really is the one this representative is here for,
      // so the table below cannot rot into covering fewer archetypes than it
      // claims.
      assert.equal(resolveByName(rep.name).archetype, rep.archetype);
    });
  }

  test(`${SIGNAL_FREE_NAME}: an unmatched name renders the INDETERMINATE grey on the card`, () => {
    const card = gradientStops(nameToGradient(SIGNAL_FREE_NAME));
    const grey = INDETERMINATE_PALETTE.colors.map((c) => c.toLowerCase());
    assert.deepEqual(card, grey, "a signal-free name must not render a confident hue");
    assert.equal(resolveNamedPalette(SIGNAL_FREE_NAME).indeterminate, true);
  });
});

describe("#35 the card is a projection of the stage palette, not a second palette", () => {
  test("every curated scene's card gradient is exactly its curated palette", () => {
    // This is the whole table, not a sample: 100+ researched rows, each one
    // checked that the library thumbnail and the 3D stage would draw the
    // same thing. A row added to the table without a matching gradient, or a
    // gradient hand-edited away from the table, fails here.
    let checked = 0;
    for (const name of CURATED_SCENE_NAMES) {
      const card = gradientStops(nameToGradient(name));
      const stage = stagePalette(name);
      const expected = stage.length > 1 ? stage : [stage[0]!, stage[0]!];
      assert.deepEqual(
        card,
        expected,
        `card gradient for curated scene "${name}" is not the stage palette`,
      );
      checked++;
    }
    assert.equal(checked, CURATED_SCENE_NAMES.length, "the whole curated table must be checked");
    assert.ok(checked >= 90, `expected the full curated table, only saw ${checked}`);
  });

  test("every curated name resolves on the curated layer, never the hash fallback", () => {
    // Layer 4 (the `sum(charCode) % 4` hash) is for names with NO signal. A
    // curated row has researched signal, so a curated name reaching layer 4
    // means the table and the resolver have stopped talking to each other.
    for (const name of CURATED_SCENE_NAMES) {
      const resolved = resolveByName(name);
      assert.equal(resolved.layer, 1, `curated scene "${name}" resolved on layer ${resolved.layer}`);
      assert.equal(resolved.indeterminate, false, `curated scene "${name}" is indeterminate`);
    }
  });
});

describe("#35 the old hash bug stays dead", () => {
  /**
   * The pre-fix `nameToGradient`: FNV-1a over the name into an HSL pair,
   * with no relation to the curated table and no relation to the stage's own
   * `sum(charCode) % 4` hash. Reproduced here so the test suite says what
   * the fix was for, and so a re-introduction of a name-hash in the card
   * path is caught by the equality tests above rather than by a screenshot.
   */
  function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function oldHashGradient(name: string): string {
    const h = fnv1a(name.toLowerCase());
    const hue = h % 360;
    const sat = 60 + (h % 30);
    const light = 40 + (h % 20);
    return `linear-gradient(135deg, hsl(${hue}, ${sat}%, ${light}%), hsl(${(hue + 120) % 360}, ${sat}%, ${light}%))`;
  }

  for (const rep of ARCHETYPE_REPRESENTATIVES) {
    test(`the old FNV-1a hash would have disagreed with the stage for "${rep.name}"`, () => {
      const old = gradientStops(oldHashGradient(rep.name));
      const stage = stagePalette(rep.name);
      const same =
        old.length === stage.length && old.every((stop, i) => stop === stage[i]);
      assert.equal(
        same,
        false,
        `the old hash happens to agree for "${rep.name}" — the equality test would not have caught the bug for this name`,
      );
    });
  }
});

describe("#35 exposure normalization leaves the INDETERMINATE grey grey", () => {
  test("the stage's own rule opts the grey out of normalization", () => {
    // `renderer.ts` computes the stage's rule as
    // `normalizeExposure = spec.paletteBasis !== "indeterminate"`. A
    // signal-free name must reach the renderer marked indeterminate, or the
    // opt-out never happens and the grey gets lifted.
    const spec = resolveByName(SIGNAL_FREE_NAME);
    assert.equal(spec.indeterminate, true);
    assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  });

  test("a rendered INDETERMINATE frame stays grey: not lifted to white", () => {
    // The frame the renderer would upload for a signal-free scene: the
    // resolver's grey, evaluated by the archetype.
    const spec = {
      archetype: "breathe" as const,
      palette: INDETERMINATE_PALETTE,
      periodSec: 6.5,
      intensity: 0.7,
      sourceName: SIGNAL_FREE_NAME,
      paletteBasis: "indeterminate" as const,
    };
    const ledTex = createLedTexture(H6022);
    evaluateLedField(spec, H6022, 0, ledTex.buffer);

    // The stage's rule: an indeterminate palette opts OUT of normalization.
    const normalizeExposure = spec.paletteBasis !== "indeterminate";
    assert.equal(normalizeExposure, false, "the stage must opt the grey out of normalization");

    const gain = uploadLedFrame(ledTex, normalizeExposure);
    assert.equal(gain, 1, "an indeterminate frame must not be exposure-lifted");

    // Still visibly grey — and specifically NOT white. The frame's peak must
    // stay well below 255, and the three channels must stay equal (the
    // shade scatter mixes toward the frame mean, which for a neutral grey
    // is the same grey).
    const peak = Math.max(
      ledTex.texels[0]!,
      ledTex.texels[1]!,
      ledTex.texels[2]!,
    );
    assert.ok(peak > 0, "the grey must still be visible, not black");
    assert.ok(peak < 255, `the grey was lifted to ${peak} — that reads as a white lamp, not as "unknown"`);
    assert.equal(ledTex.texels[0], ledTex.texels[1]);
    assert.equal(ledTex.texels[1], ledTex.texels[2]);
  });

  test("the opt-out is load-bearing: normalizing the same frame WOULD make it white", () => {
    // The counterfactual, so the test above cannot pass by accident. If the
    // grey were normalized, its peak would land on 255 — a bright white
    // lamp, a state the hardware really can be in, which turns "unknown"
    // into a claim.
    const spec = {
      archetype: "breathe" as const,
      palette: INDETERMINATE_PALETTE,
      periodSec: 6.5,
      intensity: 0.7,
      sourceName: SIGNAL_FREE_NAME,
      paletteBasis: "indeterminate" as const,
    };
    const ledTex = createLedTexture(H6022);
    evaluateLedField(spec, H6022, 0, ledTex.buffer);

    const gain = uploadLedFrame(ledTex, true);
    assert.ok(gain > 1, "normalizing a dim grey must lift it — otherwise the opt-out proves nothing");
    const peak = Math.max(ledTex.texels[0]!, ledTex.texels[1]!, ledTex.texels[2]!);
    assert.equal(peak, 255, "the normalized grey lands on white — the exact failure the opt-out exists to prevent");
  });
});
