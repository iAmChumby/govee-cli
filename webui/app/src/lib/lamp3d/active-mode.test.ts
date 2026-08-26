/**
 * Tests for `active-mode.ts` — the pure mode/honesty layer the 3D lamp
 * stage renders from. Each `test` below is named for the rule from the task
 * brief it proves; the two "port exactly" boundary tests
 * (`formatAgeShort`, the restricted-mode caption table) guard against a
 * silent behaviour drift from `stage.tsx`'s original implementation.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import type { DeviceState, DeviceSummary, LightColor } from "@/lib/api";
import { paletteFromColor, paletteFromColorTempK } from "@/lib/motion-engine/palette";
import {
  activeModeCaption,
  brightnessGlow,
  formatAgeShort,
  motionModeMetaFor,
  resolveLampState,
} from "./active-mode";

/* --------------------------------------------------------------- fixtures */

function rgb(r: number, g: number, b: number): LightColor {
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  return { hex, rgb: [r, g, b] };
}

/** A fully-specified `DeviceState` (its `active` field is required by the
 *  type, unlike `DeviceSummary`'s) with sane defaults, overridable per test. */
function makeState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    ref: "shelf",
    id: "50:CE:E8:6E:80:C6:50:3F",
    model: "H6022",
    name: "Shelf Lamp",
    transport: "cloud-v2",
    online: true,
    power: true,
    brightness: 80,
    color: null,
    color_temp_k: null,
    active: { mode: "basic", label: null, confidence: "confirmed", source: null, set_at: null, age_seconds: null },
    ...overrides,
  };
}

/* ------------------------------------------------------------- rule 1: unknown means unknown */

test("rule 1: DeviceSummary with no `active` key at all resolves to the null-claim state", () => {
  const summary: DeviceSummary = {
    ref: "orb",
    id: "5C:E7:53:69:87:FA",
    model: "H6008",
    name: "Lamp Front",
    transport: "cloud-v2",
    online: true,
    power: true,
    brightness: 60,
    color: null,
    color_temp_k: null,
    // `active` omitted entirely — an older sidecar's payload shape.
  };
  const resolved = resolveLampState(summary);
  assert.equal(resolved.spec, null);
  assert.equal(resolved.caption, null);
  assert.equal(resolved.showUnknownChooser, false);
  assert.equal(resolved.showResetControl, false);
  // power/brightness are real reads and still pass through untouched.
  assert.equal(resolved.power, true);
  assert.equal(resolved.brightness, 60);
});

test("rule 1: DeviceSummary with `active: null` (failed read) resolves the same as a missing key", () => {
  const summary: DeviceSummary = {
    ref: "orb",
    id: "5C:E7:53:69:87:FA",
    model: "H6008",
    name: "Lamp Front",
    transport: "cloud-v2",
    online: false,
    power: null,
    brightness: null,
    color: null,
    color_temp_k: null,
    active: null,
  };
  const resolved = resolveLampState(summary);
  assert.equal(resolved.spec, null);
  assert.equal(resolved.caption, null);
  assert.equal(resolved.showUnknownChooser, false);
  assert.equal(resolved.showResetControl, false);
  // a null/unreadable `power` is honestly "off", never a guessed "on".
  assert.equal(resolved.power, false);
  assert.equal(resolved.brightness, null);
});

test("rule 1: `active.mode === \"unknown\"` (a real ledger entry saying so) also renders no claim, but IS fixable", () => {
  const state = makeState({
    active: { mode: "unknown", label: null, confidence: "unknown", source: null, set_at: null, age_seconds: null },
  });
  const resolved = resolveLampState(state);
  assert.equal(resolved.spec, null);
  // Unlike the missing-`active` case above, there IS a ledger record here
  // (it just says "unknown") — so the caption and the chooser both surface,
  // matching stage.tsx's `!motionMeta && active?.mode === "unknown"` branch
  // exactly (guarded on the mode literal, not merely "no active object").
  assert.equal(resolved.caption, "unknown");
  assert.equal(resolved.showUnknownChooser, true);
  assert.equal(resolved.showResetControl, false);
});

test("guard is a truthiness check, not `!== null`: an `undefined` active must not slip past as 'known'", () => {
  // Regression for the exact trap api.ts's own doc comment calls out:
  // `undefined !== null` is `true`, so a naive `!== null` guard would fall
  // through to the "known mode" branch and crash on `active.mode`.
  const summary: DeviceSummary = {
    ref: "orb",
    id: "id",
    model: null,
    name: null,
    transport: "cloud-v2",
    online: null,
    power: null,
    brightness: null,
    color: null,
    color_temp_k: null,
  };
  assert.doesNotThrow(() => resolveLampState(summary));
  assert.equal(resolveLampState(summary).spec, null);
});

/* --------------------------------------------- rule 2: a running scene outranks the live colour fields */

test("rule 2: a scene-mode device with a bright red `color` field does NOT produce a red spec", () => {
  const state = makeState({
    color: rgb(255, 0, 0),
    color_temp_k: null,
    active: {
      mode: "scene",
      label: "Ocean Wave",
      confidence: "assumed",
      source: "cli",
      set_at: null,
      age_seconds: 60,
    },
  });
  const resolved = resolveLampState(state);
  assert.ok(resolved.spec, "scene mode must still produce a spec");
  // "Ocean Wave" resolves via the keyword classifier (layer 2, "wave") to
  // the wave archetype's default ocean palette — real per-device machinery,
  // completely independent of `color`. The failure mode this guards is the
  // classifier silently falling back to the live (stale) `color` field.
  assert.deepEqual(resolved.spec?.palette.colors, ["#1e9dd8", "#0b3d91"]);
  for (const stop of resolved.spec?.palette.colors ?? []) {
    assert.notEqual(stop.toLowerCase(), "#ff0000");
  }
});

test("rule 2: diy/music/segments/effect modes all resolve a spec without reading the live colour field", () => {
  const redField = { color: rgb(255, 0, 0), color_temp_k: null };
  const cases: Array<[DeviceState["active"]["mode"], string]> = [
    ["diy", "Sunrise"],
    ["music", "Vivid"],
    ["segments", "segments"],
    ["effect", "effect"],
  ];
  for (const [mode, label] of cases) {
    const state = makeState({
      ...redField,
      active: { mode, label, confidence: "assumed", source: "webui", set_at: null, age_seconds: 30 },
    });
    const resolved = resolveLampState(state);
    assert.ok(resolved.spec, `${mode} must produce a spec`);
  }
});

/* --------------------------------------------------------- rule 3: basic mode, basicHsl decides */

test("rule 3: basic mode with a placeholder-white colour and a real temperature — the temperature wins", () => {
  const state = makeState({
    color: rgb(255, 255, 255),
    color_temp_k: 2700,
    active: { mode: "basic", label: null, confidence: "confirmed", source: null, set_at: null, age_seconds: null },
  });
  const resolved = resolveLampState(state);
  assert.deepEqual(resolved.spec?.palette, paletteFromColorTempK(2700));
  assert.notDeepEqual(resolved.spec?.palette, paletteFromColor({ r: 255, g: 255, b: 255 }));
});

test("rule 3: basic mode with a saturated colour and a stale temperature — the colour wins", () => {
  const state = makeState({
    color: rgb(10, 200, 30),
    color_temp_k: 4000,
    active: { mode: "basic", label: null, confidence: "confirmed", source: null, set_at: null, age_seconds: null },
  });
  const resolved = resolveLampState(state);
  assert.deepEqual(resolved.spec?.palette, paletteFromColor({ r: 10, g: 200, b: 30 }));
  assert.notDeepEqual(resolved.spec?.palette, paletteFromColorTempK(4000));
});

test("off mode applies the same basicHsl-routed decision as basic mode", () => {
  const state = makeState({
    power: false,
    color: rgb(255, 255, 255),
    color_temp_k: 3000,
    active: { mode: "off", label: null, confidence: "confirmed", source: null, set_at: null, age_seconds: null },
  });
  const resolved = resolveLampState(state);
  assert.deepEqual(resolved.spec?.palette, paletteFromColorTempK(3000));
  assert.equal(resolved.power, false);
});

/* -------------------------------------------- rule 4: caption/chooser/reset are honesty UI */

test("rule 4: off/basic get a spec (for the LED field) but no caption, chooser or reset — they are live truth, not an assumption", () => {
  for (const mode of ["off", "basic"] as const) {
    const state = makeState({
      active: { mode, label: null, confidence: "confirmed", source: null, set_at: null, age_seconds: null },
    });
    const resolved = resolveLampState(state);
    assert.ok(resolved.spec, `${mode} must still resolve a spec for the LED field`);
    assert.equal(resolved.caption, null);
    assert.equal(resolved.showUnknownChooser, false);
    assert.equal(resolved.showResetControl, false);
  }
});

test("rule 4: every restricted mode gets a caption and the reset control, never the chooser", () => {
  const table: Array<[DeviceState["active"]["mode"], string]> = [
    ["scene", "scene"],
    ["diy", "DIY scene"],
    ["music", "music mode"],
    ["snapshot", "snapshot"],
    ["segments", "segments"],
    ["effect", "effect"],
  ];
  for (const [mode, label] of table) {
    const state = makeState({
      active: {
        mode,
        label: "sleep",
        confidence: "assumed",
        source: "schedule",
        set_at: null,
        age_seconds: 125,
      },
    });
    const resolved = resolveLampState(state);
    assert.equal(resolved.caption, `sleep — ${label}, assumed, 2m ago`);
    assert.equal(resolved.showResetControl, true);
    assert.equal(resolved.showUnknownChooser, false);
  }
});

test("rule 4: chooser and reset are mutually exclusive across every reachable state", () => {
  const modes: DeviceState["active"]["mode"][] = [
    "off",
    "basic",
    "scene",
    "diy",
    "music",
    "snapshot",
    "segments",
    "effect",
    "unknown",
  ];
  for (const mode of modes) {
    const state = makeState({
      active: { mode, label: "x", confidence: "assumed", source: "cli", set_at: null, age_seconds: 5 },
    });
    const resolved = resolveLampState(state);
    assert.ok(
      !(resolved.showUnknownChooser && resolved.showResetControl),
      `${mode}: chooser and reset must never both be true`,
    );
  }
});

test("caption spells out confidence verbatim, never softened", () => {
  for (const confidence of ["confirmed", "assumed", "external", "unknown"] as const) {
    const active: DeviceState["active"] = {
      mode: "scene",
      label: "sleep",
      confidence,
      source: "cli",
      set_at: null,
      age_seconds: 10,
    };
    assert.equal(activeModeCaption(active, "scene"), `sleep — scene, ${confidence}, 10s ago`);
  }
});

/* -------------------------------------------------------- age formatting boundaries */

test("formatAgeShort boundaries: 59s/60s/59m/60m/23h/24h", () => {
  assert.equal(formatAgeShort(59), "59s ago");
  assert.equal(formatAgeShort(60), "1m ago");
  assert.equal(formatAgeShort(59 * 60), "59m ago");
  assert.equal(formatAgeShort(60 * 60), "1h ago");
  assert.equal(formatAgeShort(23 * 60 * 60), "23h ago");
  assert.equal(formatAgeShort(24 * 60 * 60), "1d ago");
});

test("formatAgeShort(null) is null — no fabricated age for a record with none", () => {
  assert.equal(formatAgeShort(null), null);
});

/* ------------------------------------------------------------------- brightnessGlow */

test("brightnessGlow: 0.25..1.0 range with a visible floor, defaulting missing brightness to 50", () => {
  assert.equal(brightnessGlow(1), 0.25 + 0.75 * 0.01);
  assert.equal(brightnessGlow(100), 1);
  assert.equal(brightnessGlow(null), brightnessGlow(50));
  // out-of-range inputs clamp rather than producing a negative/absurd glow
  assert.equal(brightnessGlow(0), brightnessGlow(1));
  assert.equal(brightnessGlow(500), brightnessGlow(100));
});

/* ------------------------------------------------------------------- rule 5: no fetching */

test("rule 5: resolveLampState is synchronous and returns plain data — no promise, no network hook", () => {
  const result = resolveLampState(makeState());
  assert.equal(result instanceof Promise, false);
});

/* --------------------------------------------------------- motionModeMetaFor mapping */

test("motionModeMetaFor: restricted mapping matches stage.tsx exactly, off/basic/unknown/undefined are null", () => {
  assert.deepEqual(motionModeMetaFor("scene"), { kind: "firmware_scene", label: "scene" });
  assert.deepEqual(motionModeMetaFor("diy"), { kind: "diy_scene", label: "DIY scene" });
  assert.deepEqual(motionModeMetaFor("music"), { kind: "music_mode", label: "music mode" });
  assert.deepEqual(motionModeMetaFor("snapshot"), { kind: "solid", label: "snapshot" });
  assert.deepEqual(motionModeMetaFor("segments"), { kind: "segment_paint", label: "segments" });
  assert.deepEqual(motionModeMetaFor("effect"), { kind: "effect", label: "effect" });
  assert.equal(motionModeMetaFor("off"), null);
  assert.equal(motionModeMetaFor("basic"), null);
  assert.equal(motionModeMetaFor("unknown"), null);
  assert.equal(motionModeMetaFor(undefined), null);
});

test("effect is always null: this module never fetches PlayingEffect data", () => {
  const state = makeState({
    active: { mode: "effect", label: "effect", confidence: "assumed", source: "cli", set_at: null, age_seconds: 1 },
  });
  assert.equal(resolveLampState(state).effect, null);
});
