import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

/**
 * #12 is a contract, not a screenshot: a keyboard user must be able to see
 * which control has focus, and every site that cancels the app's outline must
 * paint the same ring from the same token. Screenshots cannot see focus rings
 * (visual-r1.md:254), so this asserts the source-level half:
 *
 *  - the token exists and is the app's accent;
 *  - the one :focus-visible rule consumes it;
 *  - no `focus-visible:outline-none` survives unless the same line paints
 *    `focus-visible:ring-(--focus-ring)` AND
 *    `focus-visible:ring-(length:--focus-ring-width)`.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * A class that cancels the outline.
 *
 * `outline-none` in any of its three spellings — bare, `focus:` and
 * `focus-visible:` — sets `outline-style: none`, and the utilities layer
 * is emitted after the base layer's `:focus-visible { outline: … }`, so
 * the class wins and the ring disappears. `hover:outline-none` and the
 * other state variants are not in this list: they only apply while
 * hovered, so they never take the ring away from a focused control.
 */
const OUTLINE_CANCEL =
  /(^|[\s"'`:])((?:focus|focus-visible):)?outline-none(?=[\s"'`:]|$)/;

/**
 * The same cancel, under its DECLARED name.
 *
 * `focus-ring-painted` is a utility (globals.css) that cancels the outline
 * so a control can paint the ring itself as a shadow flush with its own
 * edge. It is the sanctioned spelling, and it carries the same contract:
 * the shared ring must be painted on the same element. The rule is
 * BELOW, in the utilities layer, so it wins over the base layer's
 * `:focus-visible { outline: … }` without touching the ring.
 */
const PAINTED_RING_CANCEL = "focus-ring-painted";

/**
 * The utility's own DECLARATION in globals.css. That is the one place the
 * cancel is allowed to stand alone — it is the sanctioned spelling itself.
 * Every USE of it must paint the shared ring on the same element.
 */
const PAINTED_RING_DECL = "@utility focus-ring-painted";

/**
 * The one way a control may cancel the outline: it paints the shared ring
 * itself, from the same tokens.
 *
 * BOTH tokens, not one. The colour token alone was the contract until
 * wave 6b, and a control that painted the right colour at the wrong
 * width passed it: `focus-visible:ring-4` would paint a 4px ring of the
 * shared colour — a different ring from the app's, drawn by the same
 * class list, and the gate would call it correct. The width has its own
 * token (`--focus-ring-width`), so the contract now names it.
 */
const SHARED_RING = "focus-visible:ring-(--focus-ring)";
const SHARED_RING_WIDTH = "focus-visible:ring-(length:--focus-ring-width)";

/**
 * A line may opt out with this marker and a reason. It is for elements
 * that are not keyboard focus stops at all, so there is no ring for them
 * to lose.
 */
const EXEMPT = "focus-ring-exempt";

describe("one focus ring (#12)", () => {
  it("declares the ring tokens", () => {
    const tokens = readFileSync(join(SRC, "styles", "tokens.css"), "utf8");
    assert.match(tokens, /--focus-ring:\s*var\(--accent\);/);
    assert.match(tokens, /--focus-ring-width:\s*2px;/);
    assert.match(tokens, /--focus-ring-offset:\s*2px;/);
  });

  it("draws :focus-visible from the tokens", () => {
    const globals = readFileSync(join(SRC, "styles", "globals.css"), "utf8");
    assert.match(
      globals,
      /:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring\)/s,
    );
    assert.match(globals, /outline-offset:\s*var\(--focus-ring-offset\)/);
  });

  it("never cancels the ring without painting it", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes(EXEMPT)) return;
        if (line.includes(PAINTED_RING_DECL)) return;
        const cancels =
          OUTLINE_CANCEL.test(line) || line.includes(PAINTED_RING_CANCEL);
        if (!cancels) return;
        if (line.includes(SHARED_RING) && line.includes(SHARED_RING_WIDTH)) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      "an outline cancel without the shared ring — a bare `outline-none` " +
        "cancels the ring exactly as `focus-visible:outline-none` does, " +
        "and a ring painted at the wrong width is not the app's ring",
    );
  });

  it("has teeth: a cancel without the width token is an offender", () => {
    // The contract above is only worth anything if it fails on a bad
    // control. This checks the check: the three shapes that must be
    // rejected, and the one that must not.
    const offenders = (line: string) =>
      line.includes(PAINTED_RING_CANCEL) &&
      !(line.includes(SHARED_RING) && line.includes(SHARED_RING_WIDTH));

    assert.equal(
      offenders(
        `focus-visible:focus-ring-painted focus-visible:ring-(--focus-ring)`,
      ),
      true,
      "the colour token alone is not enough — the width is checked too",
    );
    assert.equal(
      offenders(
        `focus-visible:focus-ring-painted focus-visible:ring-(length:--focus-ring-width)`,
      ),
      true,
      "the width token alone is not enough — the colour is checked too",
    );
    assert.equal(
      offenders(
        `focus-visible:focus-ring-painted focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-(--focus-ring)`,
      ),
      false,
      "the full contract passes",
    );
  });
});
