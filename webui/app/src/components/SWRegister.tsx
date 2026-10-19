"use client";

import * as React from "react";

/**
 * #6 — registers the shell service worker (public/sw.js).
 *
 * Production only: in `next dev` the SW would cache the dev server's
 * HMR-mangled shell and serve it stale, which makes every iteration look
 * broken. The manifest (installability) works without the SW anyway.
 */
export function SWRegister() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("[SW] registration failed:", err));
  }, []);

  return null;
}
