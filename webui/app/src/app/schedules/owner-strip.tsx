"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Chip, Panel } from "@/components/ui";
import type { ScheduleList } from "@/lib/api";
import { formatOwner, formatZone } from "@/lib/schedule-format";

import { nextChange } from "./next-change";

/**
 * Who owns the schedule, and what happens next. Owner text comes only from
 * `formatOwner`, the same formatter Settings uses. The chip is neutral
 * chrome while a scheduler is running or waiting; anything else gets the
 * warning treatment (glyph + words, never colour alone). Never green.
 */
export function OwnerStrip({ list }: { list: ScheduleList }) {
  const owner = formatOwner(list.owner, list.now);
  const next = nextChange(list.schedules, list.now);
  const loc = list.location;
  const hasLocation = loc.latitude !== null && loc.longitude !== null;
  const warn = owner.tone === "warn";

  return (
    <Panel className="space-y-2.5 p-4 @container">
      <div className="flex items-start gap-3 max-sm:flex-col max-sm:gap-2">
        {/* Fixed column so the headline starts at the same x in every state
            (stacked above the headline on phones). */}
        <div className="w-[7.5rem] shrink-0 max-sm:w-auto">
          <Chip tone={warn ? "warn" : "neutral"}>
            {warn ? <TriangleAlert size={10} strokeWidth={2} aria-hidden /> : null}
            {owner.chip}
          </Chip>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium leading-snug text-hi">{owner.headline}</p>
          {owner.detail ? (
            <p data-volatile="true" className="mt-0.5 font-mono text-label leading-snug text-mid">
              {owner.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1 border-t border-hairline pt-2.5 font-mono text-label leading-snug text-mid">
        <p data-volatile="true">
          {next ? (
            list.owner.state === "running" ? (
              <>
                next change: <span className="text-hi">{next.names.join(", ")}</span> {next.when}
              </>
            ) : (
              <>
                next scheduled: <span className="text-hi">{next.names.join(", ")}</span> {next.when}
                {" — will not fire while no scheduler runs"}
              </>
            )
          ) : (
            "next change: none scheduled"
          )}
        </p>
        <p>
          {hasLocation ? (
            <>{`location ${loc.name?.trim() || `${loc.latitude!.toFixed(2)}, ${loc.longitude!.toFixed(2)}`} · `}<span className="whitespace-nowrap">{formatZone(loc)}</span></>
          ) : (
            <>
              no location set: sun rules have no next run.{" "}
              <Link href="/settings" className="whitespace-nowrap text-hi underline underline-offset-2">
                Set it in Settings
              </Link>
            </>
          )}
        </p>
      </div>
    </Panel>
  );
}
