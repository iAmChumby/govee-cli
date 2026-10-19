"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { hasInAppNav, markInAppNav } from "@/lib/client-nav";

/**
 * Client navigation tracker component.
 *
 * Mounts once in the root layout and marks in-app navigation
 * when the pathname changes *after* the initial load.
 * Uses a ref with cleanup to survive React StrictMode double-invocation in development.
 */
export function ClientNavTracker() {
  const pathname = usePathname();
  const hasMounted = React.useRef(false);
  const hasMarked = React.useRef(false);

  React.useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }

    // Genuine pathname change (client-side navigation)
    if (!hasMarked.current && !hasInAppNav()) {
      hasMarked.current = true;
      markInAppNav();
    }
  }, [pathname]);

  // Cleanup resets the mount guard for StrictMode double-invocation
  React.useEffect(() => {
    return () => {
      hasMounted.current = false;
    };
  }, []);

  return null;
}