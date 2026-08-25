/**
 * Tests for `budget.ts` against WEBUI_V3_SPEC.md §10.2's binding rules —
 * see that file's docblock. Run with `npm test` (vitest, node environment).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { computeBudgetReadout, shouldShowBudget, type BudgetMeterInput } from "./budget";

function meter(overrides: Partial<BudgetMeterInput> = {}): BudgetMeterInput {
  return {
    v2_today: 142,
    v1_today: 3,
    rate_limited_today: 0,
    budget_per_day: null,
    ...overrides,
  };
}

test("counts render with no band when budget_per_day is null", () => {
  const readout = computeBudgetReadout(meter({ budget_per_day: null }));
  assert.equal(readout.percent, null);
  assert.equal(readout.budgetPerDay, null);
  assert.equal(readout.v2Today, 142);
  assert.equal(readout.v1Today, 3);
});

test("a percentage appears only when budget_per_day is set, and is explicitly against that number", () => {
  const withBudget = computeBudgetReadout(meter({ v2_today: 140, budget_per_day: 500 }));
  assert.equal(withBudget.percent, 28);
  assert.equal(withBudget.budgetPerDay, 500);

  const withoutBudget = computeBudgetReadout(meter({ v2_today: 140, budget_per_day: null }));
  assert.equal(withoutBudget.percent, null);
  assert.equal(withoutBudget.budgetPerDay, null);
});

test("a budget_per_day of 0 is treated as unset, not a divide-by-zero percentage", () => {
  const readout = computeBudgetReadout(meter({ v2_today: 140, budget_per_day: 0 }));
  assert.equal(readout.percent, null);
  assert.equal(readout.budgetPerDay, null);
});

test("rate_limited_today > 0 is the only input that produces the warn tone", () => {
  const highCountNoThrottle = computeBudgetReadout(
    meter({ v2_today: 999_999, v1_today: 999_999, rate_limited_today: 0 }),
  );
  assert.equal(highCountNoThrottle.tone, "neutral");

  const throttledLowCount = computeBudgetReadout(
    meter({ v2_today: 1, v1_today: 0, rate_limited_today: 1 }),
  );
  assert.equal(throttledLowCount.tone, "warn");
});

test("v1 and v2 counts are reported separately, never summed", () => {
  const readout = computeBudgetReadout(meter({ v2_today: 100, v1_today: 7 }));
  assert.equal(readout.v2Today, 100);
  assert.equal(readout.v1Today, 7);
});

test("mock mode hides the whole readout, as the current code does", () => {
  assert.equal(shouldShowBudget(true), false);
  assert.equal(shouldShowBudget(false), true);
});
