"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "motion/react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Button, Panel, Skeleton } from "@/components/ui";
import { DeviceStage } from "@/components/stage/stage";
import { useDeviceState } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { panelIn, staggerParent } from "@/lib/motion";
import { ControlDeck } from "./control-deck";

/* ==================================================================
   /device/[ref] — Device console (WEBUI_SPEC §5.3).
   Left: the large faithful stage renderer. Right: control deck tabs.
   Collapses to a stacked column on narrow screens; StatusStrip footer.
   ================================================================== */

/** Next hands params already URL-encoded-safe; decode defensively. */
function safeDecode(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function DeviceConsolePage() {
  const params = useParams<{ ref: string }>();
  const ref = safeDecode(Array.isArray(params?.ref) ? params.ref[0] : params?.ref);

  // Keyed by ref: navigating between devices remounts the whole console, so
  // tab state, dial scrub, segment selection and scroll never leak from one
  // device into the next. The query cache keeps revisits instant regardless.
  return ref !== "" ? <DeviceConsoleContent key={ref} ref={ref} /> : null;
}

function DeviceConsoleContent({ ref }: { ref: string }) {
  const state = useDeviceState(ref);

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-6 pb-14 pt-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-micro text-low transition-colors duration-150 hover:text-hi"
        >
          <ArrowLeft size={12} strokeWidth={1.75} aria-hidden />
          console
        </Link>

        {state.isLoading ? (
          <LoadingSkeleton />
        ) : state.isError || !state.data ? (
          <ErrorPanel
            message={
              state.error instanceof ApiError
                ? state.error.message
                : "The sidecar could not resolve that device."
            }
            onRetry={() => void state.refetch()}
          />
        ) : (
          <motion.div
            variants={staggerParent}
            initial="hidden"
            animate="show"
            className="mt-4 grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]"
          >
            {/* stage column */}
            <motion.section variants={panelIn} className="lg:sticky lg:top-6">
              <DeviceStage state={state.data} className="h-[320px] sm:h-[380px] lg:h-[480px]" />
              <p className="mt-3 px-1 font-mono text-[10px] leading-relaxed text-low">
                {state.data.id}
                {state.data.capabilities?.segments
                  ? ` · ${state.data.capabilities.segment_count_cloud} cloud segments`
                  : ""}
              </p>
            </motion.section>

            {/* control deck column */}
            <ControlDeck refId={ref} state={state.data} />
          </motion.div>
        )}
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------- states */

function LoadingSkeleton() {
  return (
    <div className="mt-4 grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
      {/* stage skeleton */}
      <div className="flex h-[320px] items-center justify-center rounded-stage border border-hairline bg-raised sm:h-[380px] lg:h-[480px]">
        <Skeleton className="h-40 w-40 rounded-full" />
      </div>
      {/* deck skeleton */}
      <Panel className="px-5 pb-5 pt-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-7 w-full max-w-xs" />
        <div className="mt-8 flex justify-around gap-6">
          <Skeleton className="h-[160px] w-[160px] rounded-full" />
          <div className="w-36 space-y-3 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
        <Skeleton className="mt-8 h-5 w-full" />
        <Skeleton className="mt-6 h-7 w-full max-w-sm" />
      </Panel>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Panel className="mt-4 border-ember/40 p-5">
      <p className="text-[13px] font-medium text-hi">Device unavailable</p>
      <p className="mt-1 font-mono text-[11px] leading-relaxed text-mid">{message}</p>
      <Button variant="ghost" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
        retry
      </Button>
    </Panel>
  );
}
