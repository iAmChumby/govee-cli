/**
 * #18 — group-broadcast rollback, pure half.
 *
 * `useGroupRun` records intents for every member the moment a broadcast
 * starts (so plates hold the commanded value through the cloud's 2–6 s
 * read lag). When the broadcast fails — totally or per-member — those
 * intents must be identified and cleared, or `reconcile` keeps asserting
 * values that were never commanded successfully for up to HOLD_MS (12 s).
 *
 * Both helpers are pure so the rollback decision is unit-testable without
 * a router, query cache or DOM.
 */

import type { IntentField } from "@/lib/intent";

export interface GroupMemberResult {
  ref: string;
  ok: boolean;
}

export interface GroupBroadcastResult {
  ok: boolean;
  results: GroupMemberResult[];
}

/**
 * Which intent fields a CLI-style group command asserts — the exact mirror
 * of `recordIntentForCommand`'s switch in queries.ts. Rollback clears the
 * same fields the broadcast recorded, never more (an earlier successful
 * command for a different field keeps its hold).
 */
export function commandIntentFields(command: string): IntentField[] {
  const [verb, arg] = command.split(/\s+/, 2);
  if (!arg) return [];
  switch (verb) {
    case "power":
      return ["power"];
    case "brightness":
      return Number.isFinite(Number(arg)) ? ["brightness"] : [];
    case "color":
      return ["color", "color_temp_k"]; // color nulls temp, so temp is asserted too
    case "temp":
      return Number.isFinite(Number(arg)) ? ["color_temp_k", "color"] : [];
    default:
      return [];
  }
}

/**
 * Which members' intents must roll back for a finished group broadcast.
 *
 * - Total failure (`onError`, modelled here as `result === null`): every
 *   member — nothing was commanded successfully.
 * - Partial failure (`result.ok === false`): only the members whose own
 *   result row says `ok === false`; a member that succeeded keeps its
 *   intent so its plate still holds through the read lag.
 * - Full success: nobody.
 *
 * The returned refs are intersected with `members` (the list the broadcast
 * claimed to touch) so a stale or duplicated result row can't name a device
 * that was never part of this broadcast.
 */
export function failedGroupMembers(
  members: readonly string[],
  result: GroupBroadcastResult | null,
): string[] {
  if (result === null) return [...members];
  if (result.ok) return [];
  const failed = new Set(
    result.results.filter((r) => !r.ok).map((r) => r.ref),
  );
  return members.filter((ref) => failed.has(ref));
}
