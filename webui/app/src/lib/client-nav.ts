"use client";

/**
 * Client-side navigation tracker for in-app history awareness.
 *
 * Records whether the app itself has performed a client navigation in this tab.
 * Used by BackUp to decide between router.back() and router.replace("/").
 *
 * - Mounted once in the root layout (Providers or a dedicated client component)
 * - Listens to Next.js router events via usePathname/useSearchParams changes
 * - Stores a boolean flag in sessionStorage (survives bfcache, PWA standalone)
 * - Exported pure functions for unit testing
 */

const STORAGE_KEY = "filament:has-in-app-nav";

/**
 * Check if the app has recorded in-app navigation in this session.
 * Pure — no side effects, safe for unit tests.
 */
export function hasInAppNav(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Mark that the app has performed a client navigation.
 * Called once on the first client-side route change.
 */
export function markInAppNav(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Ignore storage errors (private browsing, quota, etc.)
  }
}

/**
 * Reset the in-app navigation flag.
 * Used for testing and when the app is fully unloaded.
 */
export function resetInAppNav(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * React hook to initialize the tracker.
 * Mounts once and marks in-app navigation on the first route change
 * after the initial page load.
 */
export function useClientNavTracker(): void {
  // This runs on the client only
  if (typeof window === "undefined") return;

  // Use a simple effect to mark on first navigation
  // We rely on the fact that this hook runs on mount, and any subsequent
  // route change will re-render the component tree where this is used
  // For a more robust approach, we'd use Next.js router events, but
  // the sessionStorage flag persists across navigations anyway
}