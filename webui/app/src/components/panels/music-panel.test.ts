/**
 * Tests for music-panel.tsx's pure helpers — the wire-payload builder and the
 * ledger-seeding rule. Both are exported specifically so the two defects they
 * fix (DEFECT A: "auto off" silently sending nothing; DEFECT B: the panel
 * asserting rhythm/60/auto as if it had read the device) are testable without
 * jsdom or @testing-library/react, neither of which this project has wired up
 * (see vitest.config.ts's docblock). Run with `npm test` (vitest, node env).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { buildMusicPayload, modeProvenanceNote, seedModeKeyFromLedger } from "./music-panel";

/* ------------------------------------------------------- buildMusicPayload */

test("auto on sends auto_color: true and no hex, even if a stale hex lingers", () => {
  const payload = buildMusicPayload("rhythm", 60, true, "#FF0066");
  assert.deepEqual(payload, { mode: "rhythm", sensitivity: 60, auto_color: true });
});

test("auto off with a picked color sends auto_color: false plus the hex", () => {
  const payload = buildMusicPayload("rhythm", 60, false, "#FF0066");
  assert.deepEqual(payload, {
    mode: "rhythm",
    sensitivity: 60,
    auto_color: false,
    hex: "#FF0066",
  });
});

test("DEFECT A: auto off with no color picked still sends an explicit auto_color: false, never {}", () => {
  const payload = buildMusicPayload("rhythm", 60, false, null);
  // The bug this guards: `...(autoColor ? { auto_color: true } : hex ? { hex } : {})`
  // collapsed to a body with no `auto_color` key at all here, which the
  // sidecar/http_v2 treat as "don't touch colour source" — indistinguishable
  // from a user who never touched the switch. `auto_color` must be present
  // and `false`.
  assert.equal("auto_color" in payload, true);
  assert.equal(payload.auto_color, false);
  assert.equal("hex" in payload, false);
  assert.deepEqual(payload, { mode: "rhythm", sensitivity: 60, auto_color: false });
});

/* -------------------------------------------------------- seedModeKeyFromLedger */

const modes = [
  { key: "rhythm", value: 2 },
  { key: "energic", value: 5 },
];

test("seeds from the ledger when the device is in music mode and the label matches a known mode", () => {
  const seeded = seedModeKeyFromLedger(
    { mode: "music", label: "energic" },
    modes,
  );
  assert.equal(seeded, "energic");
});

test("seeds nothing when the ledger's mode isn't music, even with a matching label", () => {
  const seeded = seedModeKeyFromLedger({ mode: "scene", label: "energic" }, modes);
  assert.equal(seeded, null);
});

test("seeds nothing when the label doesn't match any of this model's modes", () => {
  // A stale label from a different model's mode table (e.g. after a device
  // swap) must not be presented as this device's current mode.
  const seeded = seedModeKeyFromLedger({ mode: "music", label: "spectrum" }, modes);
  assert.equal(seeded, null);
});

test("seeds nothing when there is no ledger record at all", () => {
  assert.equal(seedModeKeyFromLedger(null, modes), null);
  assert.equal(seedModeKeyFromLedger(undefined, modes), null);
});

test("seeds nothing when the ledger entry has no label", () => {
  assert.equal(seedModeKeyFromLedger({ mode: "music", label: null }, modes), null);
});

/* ---------------------------------------------------- modeProvenanceNote */

test("claims ledger provenance only while the highlighted mode IS the ledger's", () => {
  const seeded = modeProvenanceNote("energic", "energic", "confirmed");
  assert.ok(seeded.startsWith("mode seeded from the ledger's last commanded value (confirmed)"));
});

test("a user pick that diverges from the ledger is never attributed to the ledger", () => {
  // The bug: the caption was derived from `ledgerModeKey` alone, which is
  // recomputed from props and does not change when the user clicks a chip —
  // so "seeded from the ledger's last commanded value" stayed on screen
  // under a mode the user had picked by hand and had not sent yet.
  const note = modeProvenanceNote("energic", "rhythm", "confirmed");
  assert.ok(!note.includes("seeded from the ledger"));
  assert.ok(note.includes("not the ledger's"));
  assert.ok(note.includes('"energic"'), "the ledger's own value is still stated, not hidden");
});

test("no ledger record says so outright and claims nothing about the device", () => {
  const note = modeProvenanceNote(null, "rhythm", null);
  assert.ok(note.startsWith("no usable ledger record"));
  assert.ok(!note.includes("null"), "a missing confidence must never leak into the copy");
});
