"use client";

/**
 * Intent ledger — the client half of the sync fix.
 *
 * The Govee cloud accepts a write instantly but its state read lags several
 * seconds (the sidecar compensates server-side with a write echo; this module
 * is the belt to those braces and also covers stale poll responses racing
 * in-flight mutations). Every control mutation records what the user commanded
 * and when. Every state read — polls, refocus, mutation responses — passes
 * through `reconcile`, which overlays unconfirmed intents onto the server
 * payload and drops each intent the moment the server echoes it (the cloud
 * caught up) or when it expires (trust the device again).
 *
 * The ledger also exposes a tiny subscription so switches/sliders can show a
 * "syncing" pulse for as long as a commanded value is still unconfirmed.
 */

import type { ActiveMode, DeviceState, DeviceSummary, LightColor } from "@/lib/api";

/** How long a commanded value outranks disagreeing server state. The Govee
 *  cloud routinely takes 2–6 s to reflect a write; 12 s bounds the lie if a
 *  command was silently dropped while still feeling responsive. */
const HOLD_MS = 12_000;

/** `active_mode` is the 5th, synthetic field (WEBUI_V3_SPEC.md §3/§8 T10):
 *  it does not correspond 1:1 to a `DeviceState` key (the server field is
 *  `active`, an object) — recording one lets a scene/DIY button show
 *  "applying: sleep…" the instant it's clicked, before the sidecar's ledger
 *  write lands and a poll confirms it. `reconcile` special-cases it below. */
type IntentField = "power" | "brightness" | "color" | "color_temp_k" | "active_mode";

/** The subset of `ActiveMode` a client can actually assert about its own
 *  just-issued command — never a confidence/source/timestamp, since those
 *  are server-computed facts (§3.4), not something the client commanded. */
export type ActiveModeIntentValue = Pick<ActiveMode, "mode" | "label">;

type IntentValue = boolean | number | LightColor | ActiveModeIntentValue | null;

interface Intent {
  value: IntentValue;
  at: number;
}

const ledger = new Map<string, Map<IntentField, Intent>>();

/* ------------------------------------------------------------- subscription */

const listeners = new Set<() => void>();
let notifyScheduled = false;

function notify(): void {
  // Coalesce bursts (rapid toggling fires many records in one tick).
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener();
  }, 0);
}

export function subscribeIntents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------------ records */

export interface IntentPatch {
  power?: boolean;
  brightness?: number;
  color?: LightColor | null;
  color_temp_k?: number | null;
  active_mode?: ActiveModeIntentValue | null;
}

/** Record commanded values for a device. Each field gets a fresh timestamp —
 *  the newest command per field wins, exactly like the hardware. */
export function recordIntent(ref: string, patch: IntentPatch): void {
  const now = Date.now();
  let entry = ledger.get(ref);
  if (!entry) {
    entry = new Map();
    ledger.set(ref, entry);
  }
  for (const [field, value] of Object.entries(patch) as [
    IntentField,
    IntentValue,
  ][]) {
    if (value === undefined) continue;
    entry.set(field, { value, at: now });
  }
  // Wake exactly when the last new intent expires so pending UI clears even
  // if no poll lands around then.
  setTimeout(notify, HOLD_MS + 50);
  notify();
}

function isLightColor(v: unknown): v is LightColor {
  return typeof v === "object" && v !== null && "hex" in v;
}

function isActiveModeIntentValue(v: unknown): v is ActiveModeIntentValue {
  return typeof v === "object" && v !== null && "mode" in v;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isLightColor(a) && isLightColor(b)) {
    return a.hex.toUpperCase() === b.hex.toUpperCase();
  }
  if (isActiveModeIntentValue(a) && isActiveModeIntentValue(b)) {
    return a.mode === b.mode && a.label === b.label;
  }
  return a === b;
}

/**
 * Merge pending intents into a freshly fetched state. Fields the server now
 * confirms are cleared from the ledger; fields still pending override the
 * server value (the server is behind us) and surface in `pendingFields`.
 */
export function reconcile<S extends DeviceState | DeviceSummary>(
  ref: string,
  server: S,
): S {
  const entry = ledger.get(ref);
  if (!entry || entry.size === 0) return server;

  const now = Date.now();
  const merged: S = { ...server };
  const confirmed: IntentField[] = [];

  for (const [field, intent] of entry) {
    if (now - intent.at >= HOLD_MS) {
      confirmed.push(field);
      continue;
    }
    if (field === "active_mode") {
      // No 1:1 server key — `active_mode` asserts against `server.active`'s
      // mode/label, and on divergence synthesizes a pending `ActiveMode`
      // (confidence always "assumed": this is a client claim about its own
      // just-issued command, never a server-verified fact — see §3.4).
      const wanted = intent.value as ActiveModeIntentValue | null;
      // A null `live` means the sidecar could not read this device at all, so
      // it cannot confirm anything — that is divergence, not agreement, and the
      // client's own just-issued claim stands until a read succeeds. Only an
      // explicit `wanted === null` (nothing was claimed) stands down here.
      const live = server.active;
      if (wanted === null || (live != null && sameValue({ mode: live.mode, label: live.label }, wanted))) {
        confirmed.push(field);
        continue;
      }
      (merged as unknown as { active: ActiveMode }).active = {
        mode: wanted.mode,
        label: wanted.label,
        confidence: "assumed",
        source: "webui",
        set_at: new Date(intent.at).toISOString(),
        age_seconds: Math.floor((now - intent.at) / 1000),
      };
      continue;
    }
    const serverValue = server[field as keyof S];
    if (sameValue(serverValue, intent.value)) {
      confirmed.push(field); // cloud caught up — stand down
      continue;
    }
    (merged as unknown as Record<string, unknown>)[field] = intent.value;
  }

  if (confirmed.length > 0) {
    for (const field of confirmed) entry.delete(field);
    if (entry.size === 0) ledger.delete(ref);
    notify();
  }
  return merged;
}

export interface PendingView {
  power?: boolean;
  brightness?: number;
  color?: LightColor | null;
  color_temp_k?: number | null;
  active_mode?: ActiveModeIntentValue | null;
}

/** Snapshot of unconfirmed commanded values (for syncing indicators). */
export function pendingFields(ref: string): PendingView {
  const entry = ledger.get(ref);
  if (!entry || entry.size === 0) return {};
  const now = Date.now();
  const view: PendingView = {};
  let expired = false;
  for (const [field, intent] of entry) {
    if (now - intent.at >= HOLD_MS) {
      expired = true;
      continue;
    }
    (view as Record<string, unknown>)[field] = intent.value;
  }
  if (expired) {
    for (const [field, intent] of entry) {
      if (now - intent.at >= HOLD_MS) entry.delete(field);
    }
    if (entry.size === 0) ledger.delete(ref);
  }
  return view;
}

/** True while any commanded value for this ref is still unconfirmed. */
export function isPending(ref: string): boolean {
  const entry = ledger.get(ref);
  if (!entry || entry.size === 0) return false;
  const now = Date.now();
  for (const { at } of entry.values()) {
    if (now - at < HOLD_MS) return true;
  }
  return false;
}
