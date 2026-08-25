import type { MeterSnapshot } from "./api";

/**
 * Pure formatting/threshold logic for the status strip's budget readout
 * (WEBUI_V3_SPEC.md §10 T26). Split out from `status-strip.tsx` because
 * `vitest.config.ts` runs node-environment with no jsdom — this codebase's
 * convention (see `motion-engine/classify.ts` + `classify.test.ts`) is to
 * put anything worth asserting on into a plain module rather than reach for
 * RTL to test one component.
 *
 * §10.2 is the whole point of this file, restated as code:
 *  - counts are *measured*, never a percentage of an invented limit.
 *  - `rate_limited_today > 0` is the ONLY input allowed to produce a warn
 *    tone — a 429 is real evidence the cloud throttled us; a merely high
 *    count is not evidence of anything.
 *  - a percentage renders only when the user set `request_budget_per_day`
 *    themselves, and only against that number.
 *  - v1 and v2 are counted in separate buckets and never summed.
 */

export type BudgetTone = "neutral" | "warn";

/** The subset of `MeterSnapshot` this module actually reads, so callers
 *  (and tests) don't have to fabricate the full shape. */
export type BudgetMeterInput = Pick<
  MeterSnapshot,
  "v2_today" | "v1_today" | "rate_limited_today" | "budget_per_day"
>;

export interface BudgetReadout {
  tone: BudgetTone;
  v2Today: number;
  v1Today: number;
  /** Non-null only when the user has set `request_budget_per_day`
   *  themselves — never computed against a value we invented. */
  percent: number | null;
  /** Echoes the denominator the percent above is against, so a caller
   *  never has to render a bare, unlabelled percentage. Non-null exactly
   *  when `percent` is. */
  budgetPerDay: number | null;
}

/** `rate_limited_today > 0` is the only path to `"warn"` — see module
 *  docblock. A high `v2_today`/`v1_today` never reaches this branch. */
function toneFor(meter: BudgetMeterInput): BudgetTone {
  return meter.rate_limited_today > 0 ? "warn" : "neutral";
}

export function computeBudgetReadout(meter: BudgetMeterInput): BudgetReadout {
  const hasBudget = meter.budget_per_day != null && meter.budget_per_day > 0;
  const budgetPerDay = hasBudget ? (meter.budget_per_day as number) : null;
  const percent = hasBudget
    ? Math.round((meter.v2_today / (budgetPerDay as number)) * 100)
    : null;

  return {
    tone: toneFor(meter),
    v2Today: meter.v2_today,
    v1Today: meter.v1_today,
    percent,
    budgetPerDay,
  };
}

/** Mock mode fabricates no real cloud traffic, so the readout it would
 *  describe doesn't exist yet — hide it entirely, exactly as the
 *  hardcoded `budget ~2 req/s` span it replaces already did
 *  (`!health.data?.mock`). */
export function shouldShowBudget(mock: boolean): boolean {
  return !mock;
}
