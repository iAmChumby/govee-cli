import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { decideBackOrHome } from "./back-up";

describe("decideBackOrHome", () => {
  it("goes back when the session has in-app navigation", () => {
    assert.equal(decideBackOrHome(true), "back");
  });

  it("falls home on a cold start (no in-app navigation)", () => {
    assert.equal(decideBackOrHome(false), "home");
  });
});