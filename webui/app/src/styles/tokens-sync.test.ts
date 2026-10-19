import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL("../../", import.meta.url));
const GENERATOR = fileURLToPath(new URL("../../scripts/gen-tokens.mjs", import.meta.url));
const CSS = fileURLToPath(new URL("./tokens.css", import.meta.url));
const MOTION = fileURLToPath(new URL("../lib/motion.ts", import.meta.url));

/**
 * M1's whole claim is that one declared source holds the values. That is only
 * true while both generated files still agree with it, so the gate runs the
 * generator's own --check against the committed bytes. A hand edit to
 * tokens.css or motion.ts — the exact drift M1 exists to stop — fails here.
 */
describe("tokens.tokens.json is the single declared source (M1)", () => {
  it("tokens.css and lib/motion.ts are in sync with the JSON", () => {
    const out = execFileSync(process.execPath, [GENERATOR, "--check"], {
      cwd: APP,
      encoding: "utf8",
    });
    expect(out).toContain("in sync");
  });

  it("declares the M1 slice: the four springs, fadeFast, and the four z layers", () => {
    const css = readFileSync(CSS, "utf8");
    const motion = readFileSync(MOTION, "utf8");

    for (const spring of ["standard", "heavy", "snappy", "celebrate"]) {
      expect(css).toContain(`--motion-spring-${spring}-stiffness:`);
      expect(css).toContain(`--motion-spring-${spring}-damping:`);
    }
    expect(css).toContain("--motion-fade-fast: 150ms");
    expect(css).toContain("--motion-ease-out: cubic-bezier(0, 0, 0.58, 1)");

    expect(css).toContain("--z-canvas: 10;");
    expect(css).toContain("--z-base: 20;");
    expect(css).toContain("--z-dialog: 50;");
    expect(css).toContain("--z-toast: 100;");

    // The generated JS must carry the same numbers as the CSS half.
    expect(motion).toContain("stiffness: 260");
    expect(motion).toContain("stiffness: 170");
    expect(motion).toContain("stiffness: 500");
    expect(motion).toContain("damping: 12");
    expect(motion).toContain('{ duration: 0.15, ease: "easeOut" }');
  });
});
