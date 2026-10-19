import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";

import {
  commandIntentFields,
  failedGroupMembers,
} from "./group-rollback";
import { clearIntents, isPending, recordIntent } from "./intent";

/* ---------------------------------------------------- commandIntentFields */

describe("commandIntentFields (#18)", () => {
  it("power commands assert only power", () => {
    assert.deepEqual(commandIntentFields("power on"), ["power"]);
    assert.deepEqual(commandIntentFields("power off"), ["power"]);
  });

  it("brightness commands assert only brightness", () => {
    assert.deepEqual(commandIntentFields("brightness 50"), ["brightness"]);
  });

  it("color commands assert color AND temp (color nulls temp)", () => {
    assert.deepEqual(commandIntentFields("color FF0000"), [
      "color",
      "color_temp_k",
    ]);
  });

  it("temp commands assert temp AND color (temp nulls color)", () => {
    assert.deepEqual(commandIntentFields("temp 4000"), [
      "color_temp_k",
      "color",
    ]);
  });

  it("a verb with no argument asserts nothing", () => {
    assert.deepEqual(commandIntentFields("power"), []);
    assert.deepEqual(commandIntentFields(""), []);
  });

  it("an unknown verb asserts nothing", () => {
    assert.deepEqual(commandIntentFields("disco party"), []);
  });

  it("non-numeric brightness/temp assert nothing", () => {
    assert.deepEqual(commandIntentFields("brightness max"), []);
    assert.deepEqual(commandIntentFields("temp warm"), []);
  });
});

/* --------------------------------------------------- failedGroupMembers */

const members = ["Shelf Lamp", "Light Bars", "Hall Lamp"];

describe("failedGroupMembers (#18)", () => {
  it("total failure (null result) rolls back every member", () => {
    assert.deepEqual(failedGroupMembers(members, null), members);
  });

  it("full success rolls back nobody", () => {
    const result = {
      ok: true,
      results: members.map((ref) => ({ ref, ok: true })),
    };
    assert.deepEqual(failedGroupMembers(members, result), []);
  });

  it("partial failure rolls back only the failed members", () => {
    const result = {
      ok: false,
      results: [
        { ref: "Shelf Lamp", ok: true },
        { ref: "Light Bars", ok: false },
        { ref: "Hall Lamp", ok: false },
      ],
    };
    assert.deepEqual(failedGroupMembers(members, result), [
      "Light Bars",
      "Hall Lamp",
    ]);
  });

  it("a result row naming a non-member is ignored", () => {
    // A stale/duplicated row must not clear intents on a device that was
    // never part of this broadcast.
    const result = {
      ok: false,
      results: [
        { ref: "Shelf Lamp", ok: false },
        { ref: "Ghost Device", ok: false },
      ],
    };
    assert.deepEqual(failedGroupMembers(members, result), ["Shelf Lamp"]);
  });

  it("ok:false with zero failed rows rolls back nobody", () => {
    const result = { ok: false, results: members.map((ref) => ({ ref, ok: true })) };
    assert.deepEqual(failedGroupMembers(members, result), []);
  });
});

/* ------------------------------------------- clearIntents (ledger wiring) */

describe("clearIntents (#18)", () => {
  beforeEach(() => {
    // Clean slate: clear every field any test could have recorded.
    for (const ref of ["a", "b"]) {
      clearIntents(ref, [
        "power",
        "brightness",
        "color",
        "color_temp_k",
        "active_mode",
      ]);
    }
  });

  it("clearing the recorded field ends the pending state", () => {
    recordIntent("a", { power: true });
    assert.equal(isPending("a"), true);
    clearIntents("a", commandIntentFields("power on"));
    assert.equal(isPending("a"), false, "cleared intent must stop pending");
  });

  it("clearing one field leaves an unrelated recorded field pending", () => {
    recordIntent("b", { power: true, brightness: 40 });
    clearIntents("b", ["power"]);
    assert.equal(
      isPending("b"),
      true,
      "brightness intent must survive the power rollback",
    );
    clearIntents("b", ["brightness"]);
    assert.equal(isPending("b"), false);
  });

  it("clearing a ref with no recorded intents is a no-op", () => {
    clearIntents("never-recorded", ["power"]); // must not throw
  });

  it("a cleared power intent no longer wins a disagreeing read", async () => {
    // reconcile lives in intent.ts; the honest read must pass through once
    // the failed command's intent is gone.
    const { reconcile } = await import("./intent");
    recordIntent("a", { power: true });
    clearIntents("a", ["power"]);
    const honest = reconcile("a", {
      ref: "a",
      id: "a",
      name: "A",
      model: "H6022",
      transport: "cloud-v2",
      power: false,
      brightness: 10,
      color: null,
      color_temp_k: null,
      online: true,
      active: {
        mode: "off",
        label: null,
        confidence: "confirmed",
        source: null,
        set_at: null,
        age_seconds: null,
      },
    });
    assert.equal(honest.power, false);
  });
});
