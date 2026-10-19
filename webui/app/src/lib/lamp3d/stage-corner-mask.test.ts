import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  findInlineCarrier,
  intersectBox,
  isPaintableBackground,
  maskClipInsets,
  maskClipPath,
  pickBackgroundIndex,
  stepFollow,
  type InlineStyleHost,
} from "./stage-corner-mask";

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

/**
 * D2 — the surface the corner wedge is painted in is the card's own
 * background, and that background moves: `--dev-hue`/`--dev-alpha` are
 * written on the card's root and the panel's background transitions over
 * `--dur-slow`. The first version read the colour once, at mount, and
 * watched the `.dev-bleed` panel's own attributes — which never change,
 * because the card's root is what carries the tint and the panel only
 * inherits it. So every console plate was painted in the untinted
 * `--panel` colour while the card around it carried the device's tint,
 * until something else (a scroll, a resize) happened to re-read it.
 */
describe("the card's surface colour", () => {
  it("does not treat a transparent background as a surface", () => {
    assert.equal(isPaintableBackground("rgba(0, 0, 0, 0)"), false);
    assert.equal(isPaintableBackground("transparent"), false);
    assert.equal(isPaintableBackground(""), false);
    assert.equal(isPaintableBackground("oklch(0.247423 0.0252626 56.452)"), true);
  });

  it("picks the first paintable background in the chain", () => {
    assert.equal(
      pickBackgroundIndex(["rgba(0, 0, 0, 0)", "transparent", "rgb(42, 30, 21)"]),
      2,
    );
  });

  it("returns -1 when the chain has nothing paintable", () => {
    assert.equal(pickBackgroundIndex(["rgba(0, 0, 0, 0)", "transparent"]), -1);
  });
});

describe("findInlineCarrier", () => {
  const host = (hue: string, parent: InlineStyleHost | null): InlineStyleHost => ({
    parentElement: parent,
    style: { getPropertyValue: (property) => (property === "--dev-hue" ? hue : "") },
  });

  it("finds the card's root, not the panel that only inherits its tint", () => {
    const card = host("36", null);
    const panel = host("", card);
    assert.equal(findInlineCarrier(panel, "--dev-hue"), card);
  });

  it("returns null when nobody declares the property", () => {
    assert.equal(findInlineCarrier(host("", null), "--dev-hue"), null);
  });

  it("prefers the nearest declarer", () => {
    const card = host("36", null);
    const panel = host("36", card);
    assert.equal(findInlineCarrier(panel, "--dev-hue"), panel);
  });
});

describe("the stage's corner mask follows the card's tint", () => {
  const SRC = fileURLToPath(new URL(".", import.meta.url));

  it("watches the element that carries --dev-hue, not the panel that inherits it", () => {
    const stage = readFileSync(`${SRC}LampStage.tsx`, "utf8");
    assert.match(stage, /findInlineCarrier\(surfaceElement, "--dev-hue"\)/);
    assert.match(stage, /carrierObserver\.observe\(carrier/);
    assert.doesNotMatch(stage, /surfaceObserver/);
  });

  it("re-reads the surface instead of freezing the colour it read at mount", () => {
    const stage = readFileSync(`${SRC}LampStage.tsx`, "utf8");
    assert.match(stage, /const paintSurface = \(\): void =>/);
    assert.match(stage, /readSurface\(\)/);
    assert.match(stage, /mask\.style\.boxShadow = `0 0 0 100px \$\{step\.colour\}`/);
  });
});

describe("stepFollow", () => {
  it("takes the colour it read and says it changed", () => {
    const step = stepFollow({ colour: "rgb(18, 19, 22)", settled: 0 }, "oklch(0.2474 0.0253 56.5)", 3);
    assert.equal(step.colour, "oklch(0.2474 0.0253 56.5)");
    assert.equal(step.changed, true);
    assert.equal(step.settled, 0);
    assert.equal(step.keepGoing, true);
  });

  it("keeps following while the card is still animating", () => {
    let state = { colour: "rgb(18, 19, 22)", settled: 0 };
    const seen = ["oklch(0.2 0.02 56)", "oklch(0.22 0.02 56)", "oklch(0.247 0.025 56)"];
    let last = null;
    for (const read of seen) {
      last = stepFollow(state, read, 3);
      state = { colour: last.colour, settled: last.settled };
    }
    assert.ok(last);
    assert.equal(last.keepGoing, true, "a colour that keeps moving keeps the follower alive");
  });

  it("stops once the colour has stopped changing", () => {
    let state = { colour: "rgb(18, 19, 22)", settled: 0 };
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      last = stepFollow(state, "rgb(18, 19, 22)", 3);
      state = { colour: last.colour, settled: last.settled };
    }
    assert.ok(last);
    assert.equal(last.keepGoing, false, "a settled card costs nothing");
  });

  it("keeps the colour it had when the read is not a colour", () => {
    const step = stepFollow({ colour: "rgb(18, 19, 22)", settled: 0 }, "rgba(0, 0, 0, 0)", 3);
    assert.equal(step.colour, "rgb(18, 19, 22)");
    assert.equal(step.changed, false);
  });
});
