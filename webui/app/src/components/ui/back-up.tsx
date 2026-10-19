"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/cn";

export interface BackUpProps {
  className?: string;
}

/**
 * Pure half: decide whether a back tap should pop history or fall home.
 *
 * Exported so the behaviour can be unit-tested without a router or DOM.
 */
export function decideBackOrHome(historyLength: number): "back" | "home" {
  return historyLength > 1 ? "back" : "home";
}

/**
 * History-aware back control for device pages.
 *
 * Calls `router.back()` when the session has history (the user arrived here
 * from somewhere in the app), and falls back to `router.replace("/")` on a
 * cold start (the user opened the app straight to this device page, e.g.
 * from the PWA home screen), where `router.back()` would have nowhere to go.
 *
 * Same glyph, same classes, same 44px coarse hit as the bare `← console`
 * link it replaces (#1 BackUp).
 */
export function BackUp({ className }: BackUpProps = {}) {
  const router = useRouter();

  const handleClick = React.useCallback(() => {
    const action =
      typeof window !== "undefined" ? decideBackOrHome(window.history.length) : "home";
    if (action === "back") {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] uppercase tracking-micro text-low transition-colors duration-150 hover:text-hi pointer-coarse:py-4 pointer-coarse:-my-4",
        className,
      )}
    >
      <ArrowLeft size={12} strokeWidth={1.75} aria-hidden />
      console
    </button>
  );
}
