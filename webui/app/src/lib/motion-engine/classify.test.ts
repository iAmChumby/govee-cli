/**
 * Tests for `classify.ts` against every named case in WEBUI_V3_SPEC.md §4.6,
 * plus the layer-4 hash function against its literal bucket values.
 *
 * Run with `npm test` (vitest, node environment — everything here is pure).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { classifyActiveMode, hashBucket, resolveByName } from "./classify";
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

test("O Pai — hash 425 % 4 = 1 -> gradient-drift, generic drift bank", () => {
  assert.equal(hashBucket("O Pai"), 1);
  const spec = classifyActiveMode(namedMode("O Pai"), "H6022");
  assert.equal(spec.archetype, "gradient-drift");
  assert.deepEqual(spec.palette.colors, ["#ffb37a", "#ff7ab3", "#7a9dff"]);
});

test("Dark-soho — hash 859 % 4 = 3 -> wave, generic ocean bank", () => {
  assert.equal(hashBucket("Dark-soho"), 3);
  const spec = classifyActiveMode(namedMode("Dark-soho"), "H6022");
  assert.equal(spec.archetype, "wave");
  assert.deepEqual(spec.palette.colors, ["#1e9dd8", "#0b3d91"]);
});

test("New effect — hash 951 % 4 = 3 -> wave, generic ocean bank", () => {
  assert.equal(hashBucket("New effect"), 3);
  const spec = classifyActiveMode(namedMode("New effect"), "H6022");
  assert.equal(spec.archetype, "wave");
  assert.deepEqual(spec.palette.colors, ["#1e9dd8", "#0b3d91"]);
});

test("madisonnnn — hash 1077 % 4 = 1 -> gradient-drift, generic drift bank", () => {
  assert.equal(hashBucket("madisonnnn"), 1);
  const spec = classifyActiveMode(namedMode("madisonnnn"), "H6022");
  assert.equal(spec.archetype, "gradient-drift");
  assert.deepEqual(spec.palette.colors, ["#ffb37a", "#ff7ab3", "#7a9dff"]);
});

test("FRoesy2k — hash 821 % 4 = 1 -> gradient-drift, generic drift bank, same on both devices", () => {
  assert.equal(hashBucket("FRoesy2k"), 1);
  const a = classifyActiveMode(namedMode("FRoesy2k"), "H6022");
  const b = classifyActiveMode(namedMode("FRoesy2k"), "H6056");
  assert.equal(a.archetype, "gradient-drift");
  assert.equal(b.archetype, "gradient-drift");
  assert.deepEqual(a.palette.colors, ["#ffb37a", "#ff7ab3", "#7a9dff"]);
  assert.deepEqual(b.palette.colors, a.palette.colors);
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

test("an unrecognized name with no keyword resolves via layer 4, never layer 1/2", () => {
  const resolved = resolveByName("Xkqz Bloop 42!!");
  assert.equal(resolved.layer, 4);
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
