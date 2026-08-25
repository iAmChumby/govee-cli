/**
 * Tests for `driver.ts`'s subscriber bookkeeping and plate concurrency cap
 * (WEBUI_V3_SPEC.md §4.1, §4.4). Runs under plain Node (no DOM/rAF), so it
 * only exercises the parts of the driver that don't require a browser —
 * `ensureRunning()` no-ops when `window` is undefined, which is exactly the
 * SSR-safety property §4.1 requires; the ticker itself needs a browser
 * `requestAnimationFrame`, verified manually in-browser (§9.2).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { canSubscribePlate, debugSubscriberCount, PLATE_CONCURRENCY_CAP, subscribe } from "./driver";

function noopDraw(): void {}

test("subscribe adds a subscriber and the returned unsubscribe removes it", () => {
  const before = debugSubscriberCount();
  const unsubscribe = subscribe({ id: "test-hero", priority: "hero", draw: noopDraw });
  assert.equal(debugSubscriberCount(), before + 1);
  unsubscribe();
  assert.equal(debugSubscriberCount(), before);
});

test("canSubscribePlate reports false once PLATE_CONCURRENCY_CAP plates are registered", () => {
  const unsubs: (() => void)[] = [];
  try {
    for (let i = 0; i < PLATE_CONCURRENCY_CAP; i++) {
      assert.equal(canSubscribePlate(), true, `expected room for plate #${i}`);
      unsubs.push(subscribe({ id: `plate-${i}`, priority: "plate", draw: noopDraw }));
    }
    assert.equal(canSubscribePlate(), false);
  } finally {
    unsubs.forEach((u) => u());
  }
});

test("a hero subscriber does not count against the plate cap", () => {
  const heroUnsub = subscribe({ id: "hero-only", priority: "hero", draw: noopDraw });
  try {
    assert.equal(canSubscribePlate(), true);
  } finally {
    heroUnsub();
  }
});

test("subscribing with the same id twice replaces rather than duplicates", () => {
  const before = debugSubscriberCount();
  const u1 = subscribe({ id: "dup", priority: "plate", draw: noopDraw });
  const u2 = subscribe({ id: "dup", priority: "plate", draw: noopDraw });
  assert.equal(debugSubscriberCount(), before + 1);
  u1();
  // u1's unsubscribe deletes by id, which also removed u2's registration —
  // this is expected: ids are the identity, not the closures.
  assert.equal(debugSubscriberCount(), before);
  u2();
});
