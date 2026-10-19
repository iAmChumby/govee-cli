import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { decideBackOrHome } from "./back-up";

describe("decideBackOrHome", () => {
  it("goes back when the session has history", () => {
    assert.equal(decideBackOrHome(2), "back");
    assert.equal(decideBackOrHome(10), "back");
  });

  it("falls home on a cold start (history length 1)", () => {
    assert.equal(decideBackOrHome(1), "home");
  });
});
