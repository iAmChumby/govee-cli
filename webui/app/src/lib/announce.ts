"use client";

/**
 * Announcement bus — one live region, one voice.
 *
 * Any caller publishes with `announce()`; the single mounted `<Announcer />`
 * (see `components/ui/announcer.tsx`, mounted once in `providers.tsx`)
 * renders the latest message into an `aria-live="polite"` region so screen
 * readers hear state changes nothing else speaks.
 *
 * Rules this bus enforces:
 *  - consecutive identical messages collapse into one announcement
 *    (a repeated state change is not re-announced);
 *  - nothing unconfirmed is ever announced as done — callers announce only
 *    after a server success (mutation `onSuccess`), never while an intent
 *    is pending; and
 *  - nothing announced here is also toasted, since `Toaster`'s own
 *    `aria-live="polite"` region already speaks every toast — callers pick
 *    exactly one channel.
 */

const listeners = new Set<(message: string) => void>();
let lastAnnounced: string | undefined;

/** Publish a message to the single live region. */
export function announce(message: string): void {
  if (message === lastAnnounced) return;
  lastAnnounced = message;
  for (const listener of listeners) listener(message);
}

/** Subscribe to announcements; returns an unsubscribe function. */
export function subscribeAnnouncements(
  listener: (message: string) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
