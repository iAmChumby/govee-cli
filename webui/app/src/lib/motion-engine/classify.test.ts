/**
 * Tests for `classify.ts` against every named case in WEBUI_V3_SPEC.md §4.6,
 * plus the layer-4 hash function against its literal bucket values.
 *
 * Run with `npm test` (vitest, node environment — everything here is pure).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { classifyActiveMode, hashBucket, resolveByName, resolveNamedPalette } from "./classify";
import { colorWordInName, INDETERMINATE_PALETTE } from "./palette";
import { CURATED_SCENE_NAMES } from "./scene-appearance";
import type { ActiveMode } from "./types";

function namedMode(name: string, kind: ActiveMode["kind"] = "diy_scene"): ActiveMode {
  return {
    kind,
    name,
    confidence: "assumed",
    ageSeconds: 0,
    source: "cli",
  };
}

/* --------------------------------------------- §4.6 — the 8 named cases */

test("sleep resolves via layer 1 to blob, the literal blue->magenta palette, periodSec 60", () => {
  const spec = classifyActiveMode(namedMode("sleep"), "H6022");
  assert.equal(spec.archetype, "blob");
  assert.deepEqual(spec.palette.colors, ["#2b2fb0", "#b0299a"]);
  assert.equal(spec.periodSec, 60);
});

test("sleep resolves identically on H6056 — name-stable, not device-stable", () => {
  const a = classifyActiveMode(namedMode("sleep"), "H6022");
  const b = classifyActiveMode(namedMode("sleep"), "H6056");
  assert.deepEqual(a.archetype, b.archetype);
  assert.deepEqual(a.palette.colors, b.palette.colors);
  assert.equal(a.periodSec, b.periodSec);
});

/*
 * DEVIATION FROM WEBUI_V3_SPEC.md §4.6, made deliberately: the spec's table
 * has these five names' layer-4 hash bucket resolve to a specific
 * archetype's normal (vivid/confident) default palette. That is the exact
 * fabrication bug this change set fixes — "aurora" hashing to the lava
 * palette by pure coincidence of character codes, presented with full
 * visual confidence. The hash bucket (and therefore the archetype, kept
 * only so unrelated unknown names still move differently from each other)
 * is unchanged and still matches §4.6's literal values; what changed is
 * that layer 4 no longer claims a confident PALETTE for a name with zero
 * curated/keyword signal — every one of these five now resolves to
 * `INDETERMINATE_PALETTE` and `paletteBasis: "indeterminate"` instead. If a
 * future spec revision restores per-archetype hash palettes, that decision
 * needs to explain how it squares with project law ("when there is no
 * honest basis for an assumption, the answer is unknown").
 */

test("O Pai — hash 425 % 4 = 1 -> gradient-drift motion, but an INDETERMINATE palette (no curated/keyword signal)", () => {
  assert.equal(hashBucket("O Pai"), 1);
  const spec = classifyActiveMode(namedMode("O Pai"), "H6022");
  assert.equal(spec.archetype, "gradient-drift");
  assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  assert.equal(spec.paletteBasis, "indeterminate");
});

test("Dark-soho — hash 859 % 4 = 3 -> wave motion, but an INDETERMINATE palette", () => {
  assert.equal(hashBucket("Dark-soho"), 3);
  const spec = classifyActiveMode(namedMode("Dark-soho"), "H6022");
  assert.equal(spec.archetype, "wave");
  assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  assert.equal(spec.paletteBasis, "indeterminate");
});

test("New effect — hash 951 % 4 = 3 -> wave motion, but an INDETERMINATE palette", () => {
  assert.equal(hashBucket("New effect"), 3);
  const spec = classifyActiveMode(namedMode("New effect"), "H6022");
  assert.equal(spec.archetype, "wave");
  assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  assert.equal(spec.paletteBasis, "indeterminate");
});

test("madisonnnn — a user-authored name with no signal: indeterminate, not a confident pastel", () => {
  assert.equal(hashBucket("madisonnnn"), 1);
  const spec = classifyActiveMode(namedMode("madisonnnn"), "H6022");
  assert.equal(spec.archetype, "gradient-drift");
  assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  assert.equal(spec.paletteBasis, "indeterminate");
  // every stop must be desaturated (R, G, B within a hair of each other) —
  // a "confident-looking" fabricated hue is exactly what this guards against
  for (const hex of spec.palette.colors) {
    const n = parseInt(hex.replace("#", ""), 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread <= 8, `expected a desaturated grey, got ${hex} (channel spread ${spread})`);
  }
});

test("FRoesy2k — hash 821 % 4 = 1 -> gradient-drift motion, INDETERMINATE palette, same on both devices", () => {
  assert.equal(hashBucket("FRoesy2k"), 1);
  const a = classifyActiveMode(namedMode("FRoesy2k"), "H6022");
  const b = classifyActiveMode(namedMode("FRoesy2k"), "H6056");
  assert.equal(a.archetype, "gradient-drift");
  assert.equal(b.archetype, "gradient-drift");
  assert.deepEqual(a.palette.colors, INDETERMINATE_PALETTE.colors);
  assert.deepEqual(b.palette.colors, a.palette.colors);
  assert.equal(a.paletteBasis, "indeterminate");
  assert.equal(b.paletteBasis, "indeterminate");
});

/* ------------------------------------------- the Aurora regression itself */

test("Aurora resolves to the photographed green/cyan palette via layer 1 — NOT the lava palette the old name-hash produced", () => {
  const resolved = resolveByName("Aurora");
  assert.equal(resolved.layer, 1);
  assert.equal(resolved.indeterminate, false);
  const spec = classifyActiveMode(namedMode("Aurora", "firmware_scene"), "H6022");
  assert.equal(spec.archetype, "blob");
  assert.deepEqual(spec.palette.colors, ["#1de9b6", "#00c896", "#39ff8f", "#7a4fff"]);
  assert.equal(spec.paletteBasis, "curated");
  // the regression, named directly: sum(charCodes) % 4 for "aurora" used to
  // pick GENERIC_LAVA_PALETTE (#ff4d1a/#ffb703/#c1121f) — orange/red, not
  // this scene's real green/cyan.
  for (const stop of spec.palette.colors) {
    assert.notEqual(stop.toLowerCase(), "#ff4d1a");
    assert.notEqual(stop.toLowerCase(), "#ffb703");
    assert.notEqual(stop.toLowerCase(), "#c1121f");
  }
});

test("the scene-library thumbnail (nameToGradient's resolver) and the 3D stage agree on Aurora", () => {
  const stageSpec = classifyActiveMode(namedMode("Aurora", "firmware_scene"), "H6022");
  const thumbResolution = resolveNamedPalette("Aurora");
  assert.deepEqual(thumbResolution.palette.colors, stageSpec.palette.colors);
  assert.equal(thumbResolution.indeterminate, false);
});

test("the scene-library thumbnail and the 3D stage agree on an indeterminate name too", () => {
  const stageSpec = classifyActiveMode(namedMode("madisonnnn"), "H6022");
  const thumbResolution = resolveNamedPalette("madisonnnn");
  assert.deepEqual(thumbResolution.palette.colors, stageSpec.palette.colors);
  assert.equal(thumbResolution.indeterminate, true);
  assert.equal(stageSpec.paletteBasis, "indeterminate");
});

test('Gaming resolves via layer 2 keyword "gaming" to chase, vivid multi-hue palette', () => {
  const resolved = resolveByName("Gaming");
  assert.equal(resolved.layer, 2);
  const spec = classifyActiveMode(namedMode("Gaming"), "H6056");
  assert.equal(spec.archetype, "chase");
  assert.deepEqual(spec.palette.colors, [
    "#ff003c",
    "#ff9500",
    "#fff700",
    "#00ff85",
    "#00c3ff",
    "#7a00ff",
  ]);
});

test('"make a calming, purple" combines layer 1.5 (color word) with layer 2 (keyword "calming")', () => {
  const spec = classifyActiveMode(namedMode("make a calming, purple"), "H6056");
  assert.equal(spec.archetype, "breathe");
  // The literal palette forced by the color word, overriding whatever layer 2
  // alone would have picked for "breathe".
  assert.deepEqual(spec.palette.colors, ["#6a2fb0", "#9b4fd6"]);
  // §4.6's literal periodSec for this row is 8 — distinct from breathe's
  // generic 6.5s default, which must stay 6.5 everywhere else since that's
  // the exact match to stage.tsx's existing CSS Breath cadence (§4.1's
  // zero-regression case for plain solid-color mode).
  assert.equal(spec.periodSec, 8);
});

test("breathe's generic default periodSec (6.5s) is untouched by the purple-row override — it still matches stage.tsx's Breath cadence for solid mode", () => {
  const solidSpec = classifyActiveMode(
    { kind: "solid", color: { r: 255, g: 136, b: 0 }, confidence: "assumed", ageSeconds: 0, source: "cli" },
    "H6022",
  );
  assert.equal(solidSpec.periodSec, 6.5);
  // A different calm-keyword name (not the exact §4.6 row) also keeps the
  // generic default rather than picking up the one-off 8s override.
  const otherCalmSpec = classifyActiveMode(namedMode("Calm Evening"), "H6056");
  assert.equal(otherCalmSpec.archetype, "breathe");
  assert.equal(otherCalmSpec.periodSec, 6.5);
});

/* ------------------------------------------------- layer ordering guarantees */

test("an unrecognized name with no keyword resolves via layer 4, never layer 1/2, and is flagged indeterminate", () => {
  const resolved = resolveByName("Xkqz Bloop 42!!");
  assert.equal(resolved.layer, 4);
  assert.equal(resolved.indeterminate, true);
  assert.deepEqual(resolved.palette.colors, INDETERMINATE_PALETTE.colors);
});

test("DIY names that carry real signal (built on a curated base name) resolve via layer 1, never indeterminate", () => {
  for (const name of ["Ember Fade", "Ocean Pulse", "Sunrise Circuit", "Rainbow Flow"]) {
    const resolved = resolveByName(name);
    assert.equal(resolved.layer, 1, `expected ${name} to resolve via the curated table`);
    assert.equal(resolved.indeterminate, false, `expected ${name} to carry real signal`);
  }
});

test("signal-free user-authored DIY names (no curated/keyword match) are indeterminate, not a confident guess", () => {
  for (const name of ["madisonnnn", "FRoesy2k", "O Pai"]) {
    const spec = classifyActiveMode(namedMode(name), "H6022");
    assert.equal(spec.paletteBasis, "indeterminate", `expected ${name} to be indeterminate`);
    assert.deepEqual(spec.palette.colors, INDETERMINATE_PALETTE.colors);
  }
});

test("layer 1 (exact curated match) wins over layer 2's keyword table for the same name", () => {
  // "sleep" is both the layer-1 curated key AND a layer-2 keyword (mapping
  // to "breathe") — the exact match must win, producing "blob", not "breathe".
  const resolved = resolveByName("sleep");
  assert.equal(resolved.layer, 1);
  assert.equal(resolved.archetype, "blob");
});

test("layer 1 match is case-insensitive and whitespace-trimmed", () => {
  const resolved = resolveByName("  SLEEP  ");
  assert.equal(resolved.layer, 1);
  assert.equal(resolved.archetype, "blob");
});

test("keyword match requires a whole token, not a substring", () => {
  // "cooler" must not trip the "cool" keyword-adjacent color word, and a
  // name containing "waving" (not the token "wave") must not trip layer 2's
  // "wave" keyword — it should fall through to the hash fallback instead.
  const resolved = resolveByName("waving");
  assert.notEqual(resolved.archetype, "wave" as const);
});

/* ------------------------------------------------------------ hash fallback */

test("hashBucket matches §4.6's literal values exactly", () => {
  assert.equal(hashBucket("O Pai"), 1);
  assert.equal(hashBucket("Dark-soho"), 3);
  assert.equal(hashBucket("New effect"), 3);
  assert.equal(hashBucket("madisonnnn"), 1);
  assert.equal(hashBucket("FRoesy2k"), 1);
});

test("hash fallback never lands on strobe or sparkle", () => {
  for (const name of ["O Pai", "Dark-soho", "New effect", "madisonnnn", "FRoesy2k", "zzz123", "qwerty99"]) {
    const resolved = resolveByName(name);
    if (resolved.layer === 4) {
      assert.notEqual(resolved.archetype, "strobe");
      assert.notEqual(resolved.archetype, "sparkle");
    }
  }
});

/* --------------------------------------------------------------- other kinds */

test('kind "solid" with a concrete color renders a single-stop breathe palette from that color', () => {
  const spec = classifyActiveMode(
    { kind: "solid", color: { r: 255, g: 136, b: 0 }, confidence: "assumed", ageSeconds: 0, source: "cli" },
    "H6022",
  );
  assert.equal(spec.archetype, "breathe");
  assert.deepEqual(spec.palette.colors, ["#ff8800"]);
});

test('kind "music_mode" classifies by resolved name, never a raw integer — Rhythm differs by model but is looked up by name identically', () => {
  const h6022Rhythm = classifyActiveMode(
    namedMode("Rhythm", "music_mode"),
    "H6022",
  );
  const h6056Rhythm = classifyActiveMode(
    namedMode("Rhythm", "music_mode"),
    "H6056",
  );
  assert.equal(h6022Rhythm.archetype, "wave");
  assert.equal(h6056Rhythm.archetype, "wave");
});

test('kind "effect" without effect data degrades to the solid/breathe fallback, never crashes', () => {
  const spec = classifyActiveMode(
    { kind: "effect", confidence: "assumed", ageSeconds: 0, source: "cli" },
    "H6022",
  );
  assert.equal(spec.archetype, "breathe");
});

test('kind "effect" with real keyframe data classifies statistically from color variance, not a name guess', () => {
  const spec = classifyActiveMode(
    {
      kind: "effect",
      name: "my custom effect",
      effect: {
        fps: 10,
        loop: true,
        startedAt: Date.now(),
        segments: [
          {
            id: 0,
            keyframes: [
              { t: 0, color: "ff0000" },
              { t: 1000, color: "00ff00" },
            ],
          },
        ],
      },
      confidence: "assumed",
      ageSeconds: 0,
      source: "cli",
    },
    "H6022",
  );
  // High hue variance between red and green -> blob, per classifyEffectPreview.
  assert.equal(spec.archetype, "blob");
  assert.deepEqual(spec.palette.colors.sort(), ["#00ff00", "#ff0000"].sort());
});

test("an arbitrary user-authored DIY name never crashes and never falls back to no motion", () => {
  const weirdNames = ["", "   ", "😀🔥", "123456", "!!!???", "a".repeat(500)];
  for (const name of weirdNames) {
    const spec = classifyActiveMode(namedMode(name), "H6022");
    assert.ok(spec.archetype, `expected an archetype for name ${JSON.stringify(name)}`);
    assert.ok(spec.palette.colors.length > 0);
  }
});

/* ------------------------------------- the curated table's confidence axis */

test("a curated row's confidence reaches the MotionSpec — a bare name-guess is not dressed as ground truth", () => {
  // scene-appearance.ts carries a confidence column whose whole purpose is
  // to separate "photographed on this project's own H6022" (aurora) from
  // "inferred purely from the name, no corroboration at all" (karst cave).
  // If that column stops reaching a caller, both render with identical
  // authority and the column is decoration.
  const aurora = classifyActiveMode(namedMode("Aurora", "firmware_scene"), "H6022");
  assert.equal(aurora.paletteBasis, "curated");
  assert.equal(aurora.paletteConfidence, "high");

  const karst = classifyActiveMode(namedMode("Karst Cave", "firmware_scene"), "H6022");
  assert.equal(karst.paletteBasis, "curated");
  assert.equal(karst.paletteConfidence, "low");
});

test("a keyword match is 'medium' and an indeterminate name carries no confidence at all", () => {
  const keyword = resolveByName("Gaming");
  assert.equal(keyword.layer, 2);
  assert.equal(keyword.paletteConfidence, "medium");

  const unknown = classifyActiveMode(namedMode("madisonnnn"), "H6022");
  assert.equal(unknown.paletteBasis, "indeterminate");
  assert.equal(unknown.paletteConfidence, undefined);
});

test("a colour word overriding a curated row reports the colour word's standing, not the row's", () => {
  // The palette rendered is the colour word's, so the confidence reported
  // must describe THAT palette — quoting the overridden row's confidence
  // would attach a photographed row's authority to a palette it did not
  // produce.
  const resolved = resolveNamedPalette("Blue Karst Cave");
  assert.equal(resolved.indeterminate, false);
  assert.equal(resolved.paletteConfidence, "medium");
});

test("no curated row's name contains a colour word — layer 1.5 would silently discard its research", () => {
  // Layer 1.5 (a literal colour word in the name) overrides the palette of
  // every other layer, curated rows included. That is fine while no curated
  // name contains one. The moment one does, the researched palette is
  // dropped for the generic colour-word pair with nothing to notice — so
  // this fails at the point the conflict is introduced, and whoever adds
  // the row decides which source of truth wins instead of finding out from
  // a wrong-coloured lamp.
  for (const name of CURATED_SCENE_NAMES) {
    assert.equal(
      colorWordInName(name),
      null,
      `curated row "${name}" contains a colour word; layer 1.5 will override its researched palette`,
    );
  }
});
