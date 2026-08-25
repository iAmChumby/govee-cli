import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The motion engine and the paint studio carry real unit tests — the
 * gamma-correct downsample, the scene-name resolver's hash buckets, the
 * keyframe emit-on-change dedup — and none of them could be executed: they were
 * written against node:test with no runner wired, so `npm test` did not exist
 * and CI never saw them.
 *
 * Node-environment only: everything under test is pure (typed arrays, colour
 * maths, classification). Nothing here renders a component, so jsdom would be
 * weight without benefit. If a component test ever lands, give that file its
 * own `// @vitest-environment jsdom` docblock rather than slowing this down.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // Mirrors tsconfig's "@/*" path alias so tests import the way the app does.
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
