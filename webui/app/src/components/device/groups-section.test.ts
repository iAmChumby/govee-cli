import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { groupsBranch } from "./groups-section";

const error = new Error("sidecar unreachable");

describe("groupsBranch", () => {
  it("shows a skeleton on the first read, before any answer exists", () => {
    assert.equal(
      groupsBranch({ data: undefined, isLoading: true, error: null }),
      "loading",
    );
  });

  it("reports an unreachable sidecar as an error, never as empty", () => {
    // The bug this guards: an unreachable sidecar used to render
    // "no groups configured — add one under settings" — a claim of absence
    // from a read that never happened (CLAUDE.md:143).
    assert.equal(
      groupsBranch({ data: undefined, isLoading: false, error }),
      "error",
    );
  });

  it("shows today's copy only when a successful read returned no groups", () => {
    assert.equal(
      groupsBranch({ data: {}, isLoading: false, error: null }),
      "empty",
    );
  });

  it("renders the panel when a successful read returned groups", () => {
    assert.equal(
      groupsBranch({
        data: { shelf: ["a"], bedroom: ["b", "c"] },
        isLoading: false,
        error: null,
      }),
      "populated",
    );
  });

  it("keeps the loading answer authoritative while the first read is in flight", () => {
    assert.equal(
      groupsBranch({ data: undefined, isLoading: true, error }),
      "loading",
    );
  });
});
