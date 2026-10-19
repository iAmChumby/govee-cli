import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it } from "vitest";

import { hasInAppNav, markInAppNav, resetInAppNav } from "./client-nav";

beforeEach(() => {
  resetInAppNav();
});

describe("client-nav flag", () => {
  it("starts false on a fresh document", () => {
    assert.equal(hasInAppNav(), false);
  });

  it("becomes true after an in-app navigation", () => {
    markInAppNav();
    assert.equal(hasInAppNav(), true);
  });

  it("resets to false", () => {
    markInAppNav();
    resetInAppNav();
    assert.equal(hasInAppNav(), false);
  });

  it("full cycle: false -> mark -> true -> reset -> false", () => {
    assert.equal(hasInAppNav(), false);
    markInAppNav();
    assert.equal(hasInAppNav(), true);
    resetInAppNav();
    assert.equal(hasInAppNav(), false);
  });

  // D1: sessionStorage is cloned into window.open()'d tabs; module state is
  // not. A source guard is the only way to keep a future edit from quietly
  // restoring the copied-storage behaviour.
  it("does not use sessionStorage or window", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./client-nav.ts", import.meta.url)),
      "utf8",
    );
    // Comments are allowed to name the mechanism; code is not.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.equal(code.includes("sessionStorage"), false);
    assert.equal(code.includes("window"), false);
  });
});
