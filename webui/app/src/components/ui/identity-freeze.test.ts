import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { Chip } from "./chip";
import { Dial } from "./dial";
import { SectionLabel } from "./section-label";
import { Slider } from "./slider";
import { StatusDot } from "./status-dot";
import { Switch } from "./switch";

/**
 * #34 — freeze the identity components before the purge.
 *
 * The purge (#30/M3) is allowed to *promote* these components — replace their
 * raw markup with `Box`/`Stack`/`Text` — but not to restyle them. This test is
 * the "not restyle" half:
 *
 *  1. every identity component is rendered to static markup with the prop
 *     combinations that carry its identity (Switch neutral/hue/pending,
 *     Slider neutral/tinted with its value bubble, all three StatusDot tones
 *     with and without the #15 second channel, all five Chip tones,
 *     SectionLabel with and without its index, the Dial, the brand wordmark)
 *     and the exact emitted markup is compared with a committed snapshot;
 *  2. tokens.css and globals.css — the other two inputs to every computed
 *     style — are hashed against the values recorded when the computed-style
 *     snapshot was taken.
 *
 * Together those two make a style change impossible without failing: a class
 * edit changes the markup snapshot, a token/base-rule edit changes the hash.
 * The recorded computed values themselves live in
 * `src/styles/identity-styles.snapshot.json`, produced by
 * `scripts/identity_styles.py record` against a real Chromium in both themes,
 * and re-checked with `identity_styles.py check`.
 *
 * Freeze the look, not the structure: when #30 promotes a component, update
 * the markup snapshot in the same commit and confirm the computed-style
 * `check` is still zero-diff. Never update it to make a restyle pass.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const APP = fileURLToPath(new URL("../../..", import.meta.url));
const CLASS_SNAPSHOT = join(SRC, "components", "ui", "identity-classes.snapshot.json");
const STYLE_SNAPSHOT = join(SRC, "styles", "identity-styles.snapshot.json");

const noop = () => {};

function renderAll(): Record<string, { html: string; reason: string }> {
  const cases: Record<string, { element: React.ReactElement; reason: string }> = {
    "switch.neutral": {
      element: React.createElement(Switch, {
        checked: false,
        onCheckedChange: noop,
        ariaLabel: "Power Shelf Lamp",
      }),
      reason: "the neutral power toggle: 48x28 track, 22px thumb, accent gradient fill",
    },
    "switch.hue": {
      element: React.createElement(Switch, {
        checked: true,
        onCheckedChange: noop,
        ariaLabel: "Power Shelf Lamp",
        hue: true,
      }),
      reason: "#34 LOW note: the prop-driven tinted Switch (inline --dev-hue gradient)",
    },
    "switch.pending": {
      element: React.createElement(Switch, {
        checked: true,
        onCheckedChange: noop,
        ariaLabel: "Power Shelf Lamp",
        pending: true,
      }),
      reason: "the unconfirmed-command halo; #34 read #15's second channel first",
    },
    "slider.neutral": {
      element: React.createElement(Slider, {
        value: 70,
        onValueChange: noop,
        ariaLabel: "Color temperature",
      }),
      reason: "the neutral hairline slider: 2px track, 20px thumb chip, 6px inner dot",
    },
    "slider.tinted": {
      element: React.createElement(Slider, {
        value: 70,
        onValueChange: noop,
        ariaLabel: "Shelf Lamp brightness",
        tint: true,
        showBubble: true,
      }),
      reason: "#34 LOW note: the prop-driven tinted Slider's emitted classes and bubble",
    },
    "statusdot.ok": {
      element: React.createElement(StatusDot, { tone: "ok" }),
      reason: "7x7 presence dot; colour is the only channel when unlabelled",
    },
    "statusdot.warn.labelled": {
      element: React.createElement(StatusDot, { tone: "warn", label: "timed out" }),
      reason: "#15's second channel: ring plus sr-only label, same 7x7 dot",
    },
    "statusdot.off": {
      element: React.createElement(StatusDot, { tone: "off" }),
      reason: "the still, half-opacity offline dot",
    },
    "chip.neutral": {
      element: React.createElement(Chip, null, "H6022"),
      reason: "hairline chip used for model/transport tags",
    },
    "chip.accent": {
      element: React.createElement(Chip, { tone: "accent" }, "H6022"),
      reason: "accent chip on the device header",
    },
    "chip.ok": {
      element: React.createElement(Chip, { tone: "ok" }, "playing"),
      reason: "sage status chip",
    },
    "chip.warn": {
      element: React.createElement(Chip, { tone: "warn" }, "rate-limited"),
      reason: "ember status chip",
    },
    "chip.signal": {
      element: React.createElement(Chip, { tone: "signal" }, "Shelf Lamp · aurora"),
      reason: "the SIGNAL-SPILL chip: fills from var(--dev-hue) instead of a token",
    },
    "sectionLabel.index": {
      element: React.createElement(SectionLabel, { index: "01", title: "power" }),
      reason: "explicitly frozen at section-label.tsx:12-23; #16 must not touch it",
    },
    "sectionLabel.rule": {
      element: React.createElement(SectionLabel, { title: "devices" }),
      reason: "the rule-only label keeps the same 11px title and hairline",
    },
    "dial": {
      element: React.createElement(Dial, {
        value: 70,
        label: "Shelf Lamp brightness",
        unit: "%",
        onValueChange: noop,
      }),
      reason: "the instrument: 270-degree arc, 28 ticks, indicator, readout and unit",
    },
  };

  const out: Record<string, { html: string; reason: string }> = {};
  for (const [key, { element, reason }] of Object.entries(cases)) {
    out[key] = { html: renderToStaticMarkup(element), reason };
  }

  // The brand is inline markup in top-bar.tsx, not a component. Freeze the
  // two class strings it emits; the computed values are in the style snapshot.
  const topBar = readFileSync(join(SRC, "components", "shell", "top-bar.tsx"), "utf8");
  const wordmark = topBar.match(/<span className="([^"]*text-title[^"]*)">/);
  const dot = topBar.match(/className="([^"]*animate-dot-breathe[^"]*)"/);
  assert.ok(wordmark, "brand wordmark span not found in top-bar.tsx");
  assert.ok(dot, "brand breathe dot not found in top-bar.tsx");
  out["brand.wordmark"] = { html: wordmark[1], reason: "the filament wordmark's type and tracking" };
  out["brand.dot"] = { html: dot[1], reason: "the 5px status pinhole beside the wordmark" };

  return out;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const styleSnapshot = JSON.parse(readFileSync(STYLE_SNAPSHOT, "utf8")) as {
  inputs: Record<string, string>;
  parts: Record<string, { route: string; selector: string; index: number; values: Record<string, string> }>;
};

describe("identity components are frozen (#34)", () => {
  it("emits exactly the markup recorded before the purge", () => {
    const current = renderAll();
    if (process.env.UPDATE_IDENTITY_SNAPSHOT === "1") {
      writeFileSync(CLASS_SNAPSHOT, JSON.stringify(current, null, 1) + "\n", "utf8");
    }
    assert.ok(
      existsSync(CLASS_SNAPSHOT),
      "identity-classes.snapshot.json is missing; regenerate with UPDATE_IDENTITY_SNAPSHOT=1 npm test",
    );
    const expected = JSON.parse(readFileSync(CLASS_SNAPSHOT, "utf8"));
    assert.deepEqual(current, expected);
  });

  it("still consumes the exact tokens and base rules the styles were recorded from", () => {
    for (const [rel, hash] of Object.entries(styleSnapshot.inputs)) {
      assert.equal(
        sha256(join(APP, "..", "..", rel)),
        hash,
        `${rel} changed since the identity styles were recorded; re-record with scripts/identity_styles.py and review the diff`,
      );
    }
  });

  it("records every identity part in both themes", () => {
    const parts = Object.keys(styleSnapshot.parts);
    assert.ok(parts.length >= 50, `only ${parts.length} part records`);
    for (const key of parts) {
      assert.ok(key.endsWith(".dark") || key.endsWith(".light"), `${key} has no theme`);
    }
    const names = [
      "brand.wordmark",
      "brand.dot",
      "chip.neutral",
      "chip.accent",
      "sectionLabel.index",
      "sectionLabel.dash",
      "sectionLabel.title",
      "statusdot.labelled.dot",
      "statusdot.plain.dot",
      "switch.neutral.track",
      "switch.hue.track",
      "slider.neutral.thumb",
      "slider.tinted.fill",
      "dial.root",
      "dial.arc",
      "dial.readout",
      "dial.unit",
    ];
    for (const name of names) {
      for (const theme of ["dark", "light"]) {
        assert.ok(styleSnapshot.parts[`${name}.${theme}`], `missing ${name}.${theme}`);
      }
    }
  });

  it("keeps the measured identity values", () => {
    const value = (part: string, prop: string, theme = "dark") =>
      styleSnapshot.parts[`${part}.${theme}`]?.values[prop];

    // From the component comments and #34's evidence: these are the sizes the
    // identity is defined by, not incidental layout.
    assert.equal(value("switch.neutral.track", "width"), "48px");
    assert.equal(value("switch.neutral.track", "height"), "28px");
    assert.equal(value("switch.neutral.thumb", "width"), "22px");
    assert.equal(value("slider.neutral.thumb", "width"), "20px");
    assert.equal(value("slider.neutral.thumb", "height"), "20px");
    assert.equal(value("slider.neutral.dot", "width"), "6px");
    assert.equal(value("statusdot.plain.dot", "width"), "7px");
    assert.equal(value("statusdot.labelled.dot", "width"), "7px");
    assert.equal(value("sectionLabel.title", "font-size"), "11px");
    assert.equal(value("sectionLabel.index", "font-size"), "10px");
    assert.equal(value("chip.neutral", "font-size"), "10px");
    assert.equal(value("dial.root", "width"), "160px");
    assert.equal(value("dial.readout", "font-size"), "14px");
    assert.equal(value("dial.unit", "font-size"), "9px");
    assert.equal(value("brand.wordmark", "font-size"), "17px");

    // Both themes must resolve to different ink; a frozen "style" that is the
    // same in both is the light-theme path being uncarried.
    assert.notEqual(
      value("brand.wordmark", "color", "dark"),
      value("brand.wordmark", "color", "light"),
    );
    assert.notEqual(
      value("chip.neutral", "color", "dark"),
      value("chip.neutral", "color", "light"),
    );
  });
});
