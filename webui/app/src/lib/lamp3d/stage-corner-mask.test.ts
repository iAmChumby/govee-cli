import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { intersectBox, maskClipInsets, maskClipPath } from "./stage-corner-mask";

/**
 * D1 — the stage's corner mask is a body-level painter, exactly like the
 * shared canvas, so it has to clip to the same rect the canvas scissors to.
 * Before the fix the mask's clip-path was the constant `inset(50% 0 0 0)`:
 * it kept the two bottom corner wedges, but nothing stopped those wedges
 * from landing on the TopBar when a stage was scrolled half out of its
 * scrolling ancestor.
 *
 * The geometry is pure on purpose — the DOM layer only supplies rectangles —
 * so the rule is testable without a browser.
 */

const MASK = { left: 33, top: -131.5, width: 324, height: 187 };
/** A 390x844 phone: the TopBar is 48px tall and `main` starts under it. */
const SCROLLER = { left: 0, top: 48, width: 390, height: 796 };

describe("intersectBox", () => {
  it("returns the overlapping rectangle", () => {
    assert.deepEqual(
      intersectBox({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 }),
      { left: 5, top: 5, width: 5, height: 5 },
    );
  });

  it("returns null when the boxes do not overlap", () => {
    assert.equal(
      intersectBox({ left: 0, top: 0, width: 10, height: 10 }, { left: 50, top: 0, width: 10, height: 10 }),
      null,
    );
  });

  it("returns null when the boxes only touch", () => {
    assert.equal(
      intersectBox({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 }),
      null,
    );
  });
});

describe("maskClipInsets", () => {
  it("keeps only the bottom half when there is no scroller", () => {
    assert.deepEqual(maskClipInsets(MASK, null), { top: 93.5, right: 0, bottom: 0, left: 0 });
  });

  it("stops the mask at the scroller's top edge, so it cannot paint the TopBar", () => {
    // The stage's bottom edge sits at 55.5, the scroller's top at 48: the
    // wedge would straddle the TopBar's bottom edge without this clip.
    const stage = { left: 33, top: -131.5, width: 324, height: 187 };
    const scroller = { left: 0, top: 48, width: 390, height: 796 };
    const clip = intersectBox(stage, scroller);
    assert.ok(clip);
    const insets = maskClipInsets(stage, clip);
    // The painted region starts at the scroller's edge, never above it.
    assert.equal(stage.top + insets.top, 48);
    assert.ok(insets.top > stage.height / 2, "the scroller edge is the stricter rule here");
  });

  it("keeps the bottom-half rule when the scroller is above the stage's middle", () => {
    const stage = { left: 33, top: 100, width: 324, height: 187 };
    const scroller = { left: 0, top: 48, width: 390, height: 796 };
    const clip = intersectBox(stage, scroller);
    assert.ok(clip);
    const insets = maskClipInsets(stage, clip);
    assert.equal(insets.top, stage.height / 2);
    assert.equal(insets.bottom, 0);
    assert.equal(insets.left, 0);
    assert.equal(insets.right, 0);
  });

  it("stops the mask at the scroller's bottom edge too", () => {
    const stage = { left: 33, top: 100, width: 324, height: 187 };
    const scroller = { left: 0, top: 48, width: 390, height: 200 };
    const clip = intersectBox(stage, scroller);
    assert.ok(clip);
    const insets = maskClipInsets(stage, clip);
    assert.equal(stage.top + stage.height - insets.bottom, 248);
  });

  it("never insets past its own box", () => {
    const insets = maskClipInsets(MASK, { left: -100, top: -100, width: 1000, height: 1000 });
    assert.equal(insets.left, 0);
    assert.equal(insets.right, 0);
    assert.equal(insets.bottom, 0);
    assert.ok(insets.top <= MASK.height);
  });
});

describe("maskClipPath", () => {
  it("is an inset() box", () => {
    assert.equal(maskClipPath(MASK, null), "inset(93.5px 0px 0px 0px)");
  });

  it("carries the scroller's edge", () => {
    const stage = { left: 33, top: -131.5, width: 324, height: 187 };
    const clip = intersectBox(stage, SCROLLER);
    assert.ok(clip);
    assert.equal(maskClipPath(stage, clip), "inset(179.5px 0px 0px 0px)");
  });
});

describe("the stage's corner mask clips to the scroller", () => {
  const SRC = fileURLToPath(new URL(".", import.meta.url));

  it("clips with the shared helper, not a hard-coded half-box", () => {
    const stage = readFileSync(`${SRC}LampStage.tsx`, "utf8");
    assert.match(stage, /mask\.style\.clipPath = maskClipPath\(/);
    assert.doesNotMatch(stage, /inset\(50% 0 0 0\)/);
  });

  it("takes its scrolling ancestor from the function the canvas uses", () => {
    const stage = readFileSync(`${SRC}LampStage.tsx`, "utf8");
    assert.match(stage, /findScrollAncestor\(stage\)/);
    assert.doesNotMatch(stage, /closest\("main"\)/);
  });
});
