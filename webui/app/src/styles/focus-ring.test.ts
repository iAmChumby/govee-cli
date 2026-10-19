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
 *    `focus-visible:ring-(--focus-ring)`.
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
      if (file.endsWith(".test.ts")) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes("focus-visible:outline-none") && !line.includes("focus-visible:ring-(--focus-ring)")) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], "focus-visible:outline-none without the shared ring");
  });
});
