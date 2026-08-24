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

import type { DeviceState, DeviceSummary, LightColor } from "@/lib/api";

/** How long a commanded value outranks disagreeing server state. The Govee
 *  cloud routinely takes 2–6 s to reflect a write; 12 s bounds the lie if a
 *  command was silently dropped while still feeling responsive. */
const HOLD_MS = 12_000;

type IntentField = "power" | "brightness" | "color" | "color_temp_k";

interface Intent {
  value: boolean | number | LightColor | null;
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
    boolean | number | LightColor | null,
  ][]) {
    if (value === undefined) continue;
    entry.set(field, { value, at: now });
  }
  // Wake exactly when the last new intent expires so pending UI clears even
  // if no poll lands around then.
  setTimeout(notify, HOLD_MS + 50);
  notify();
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ca = a as LightColor;
    const cb = b as LightColor;
    return ca.hex.toUpperCase() === cb.hex.toUpperCase();
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
