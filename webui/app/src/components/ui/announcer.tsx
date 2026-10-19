"use client";

import * as React from "react";

import { subscribeAnnouncements } from "@/lib/announce";

/**
 * The single live region for the whole app — mounted exactly once, inside
 * `Providers` beside `Toaster`.
 *
 * `aria-live="polite"` + `aria-atomic` means the region is read as a whole
 * when its text changes, at a quiet moment; `sr-only` keeps it off the
 * screen while remaining in the accessibility tree. Rendered content is
 * the last announced message only — announcements do not accumulate, and
 * the bus above collapses consecutive identical messages, so the same
 * state change is never spoken twice.
 */
export function Announcer() {
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    return subscribeAnnouncements((msg) => setMessage(msg));
  }, []);

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      aria-relevant="additions text"
      className="sr-only pointer-events-none"
    >
      {message ?? ""}
    </div>
  );
}
