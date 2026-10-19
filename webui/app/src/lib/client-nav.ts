"use client";

/**
 * Per-tab (per-document) in-app navigation flag.
 *
 * BackUp uses this to choose between router.back() and router.replace("/"):
 * after an in-app navigation there is somewhere to go back to; on a cold
 * deep-link there is not.
 *
 * Deliberately a module-level binding, not sessionStorage (D1). Chrome copies
 * sessionStorage into a tab opened with window.open(), so a cold-opened tab
 * would inherit "true" from the tab that opened it and BackUp would call
 * router.back() with nowhere to go. A module binding lives in one JS realm:
 * a new tab, a new window, or a fresh document starts at false.
 */

let hasNavigated = false;

/** True once this document has performed a client-side navigation. */
export function hasInAppNav(): boolean {
  return hasNavigated;
}

/** Mark that this document has performed a client-side navigation. */
export function markInAppNav(): void {
  hasNavigated = true;
}

/**
 * Clear the flag.
 *
 * The app never calls this: the flag is per document, so a reload gets a
 * fresh module and a fresh false without anything being reset. It exists
 * for the tests, which share one module instance across cases.
 */
export function resetInAppNav(): void {
  hasNavigated = false;
}
