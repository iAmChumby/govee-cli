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
      {/*
        T34 (WEBUI_V3_SPEC §11.6): the dial's vertical position is chassis-
        above-it plus the stage height. Every `max-md:` here shaves the
        chassis stack (container padding, back-link-to-grid margin, the
        caption's margin/line-height, the grid gap) *before* the stage
        height is touched at all, per the task's ordering. Total chassis
        recovery below md is ~59px; the stage's bare value below picks up
        the rest. None of these are resets of a shared class — each is a
        pure `max-md:` addition, inert at and above md by construction
        (§11.1), so 1440x900 cannot move.
      */}
      <div className="mx-auto max-w-[1200px] px-6 pb-14 pt-6 max-md:pt-3">
        {/*
          §11.3: this is the only way back to the dashboard other than the
          top-bar nav, and it measures 87x17 — nowhere near the 44px floor.
          `pointer-coarse:py-4` adds 16px above and below, taking the box to
          ~49px (17 + 32), comfortably past 44 rather than landing on it.

          Growing padding alone would push T34's chassis stack down: that
          task already trimmed the container padding, this margin and the
          caption just to get the brightness dial above the fold at
          390x844, and 32px of added flow height here would eat straight
          back into that budget. `pointer-coarse:-my-4` cancels it exactly
          in the flow, without touching the box's own rendered size: for a
          statically-positioned element, the next sibling's flow position
          is (elementBottom + marginBottom). Padding moves elementBottom
          down by 16px; margin-bottom of -16px subtracts the same 16px
          back off, so the grid below sits at the identical y it had
          before this change (elementTop shifts up 16px into the
          container's own top padding for the same reason, in the other
          direction — nothing else lives above this link to collide with).
          Net: the tappable box grows to 49px tall, the document flow does
          not grow at all.

          Both utilities are `pointer-coarse:`-gated, so a mouse-driven
          1440x900 desktop never matches the media query and the link's
          box stays exactly 87x17 — the padding/margin pair doesn't merely
          cancel *each other*, it's inert in its entirety at fine pointer,
          which is what the gate in §11.1 checks.
        */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-micro text-low transition-colors duration-150 hover:text-hi pointer-coarse:py-4 pointer-coarse:-my-4"
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
            className="mt-4 max-md:mt-2 grid min-w-0 items-start gap-5 max-md:gap-3 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]"
          >
            {/* stage column */}
            <motion.section variants={panelIn} className="lg:sticky lg:top-6">
              {/*
                Bare value only (T34): sm:/lg: already fully override this
                property at their breakpoints, so lowering the bare value
                only touches widths below sm (the 390px gate included) and
                cannot move the sm/lg/desktop renders — unlike a shared
                class elsewhere in this codebase, there is no "forgotten
                override" failure mode here because the overrides already
                exist and already win unconditionally above sm. 320->260
                is the stage's contribution to T34's fold budget; the rest
                comes from the max-md: chassis trims around it.
              */}
              <DeviceStage state={state.data} className="h-[260px] sm:h-[380px] lg:h-[480px]" />
              <p className="mt-3 max-md:mt-1.5 px-1 font-mono text-[10px] leading-relaxed max-md:leading-snug text-low">
                {state.data.id}
                {state.data.model === "H6022" ? " · 132-led 12×11 wrapped matrix" : ""}
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
    <div className="mt-4 max-md:mt-2 grid min-w-0 items-start gap-5 max-md:gap-3 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
      {/* stage skeleton — mirrors the loaded stage's bare-value height (T34) so the skeleton-to-content swap doesn't itself jump the layout */}
      <div className="flex h-[260px] items-center justify-center rounded-stage border border-hairline bg-raised sm:h-[380px] lg:h-[480px]">
        <Skeleton className="h-40 w-40 rounded-full" />
      </div>
      {/* deck skeleton */}
      <Panel className="px-5 pb-5 pt-4 max-md:pt-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-7 w-full max-w-xs" />
        {/* mirrors the loaded cluster's deliberate no-wrap arrangement below md (T34) */}
        <div className="mt-8 flex flex-wrap justify-around gap-6 max-md:flex-nowrap max-md:justify-between max-md:gap-4">
          <Skeleton className="h-[160px] w-[160px] shrink-0 rounded-full" />
          <div className="w-36 max-md:w-[120px] space-y-3 py-4">
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
