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
      <div className="flex items-start gap-3">
        <Chip tone={warn ? "warn" : "neutral"} className="mt-px shrink-0">
          {warn ? <TriangleAlert size={10} strokeWidth={2} aria-hidden /> : null}
          {owner.chip}
        </Chip>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-hi">{owner.headline}</p>
          {owner.detail ? (
            <p data-volatile="true" className="mt-0.5 font-mono text-[11px] leading-snug text-mid">
              {owner.detail}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1 border-t border-hairline pt-2.5 font-mono text-[11px] leading-snug text-mid">
        <p data-volatile="true">
          {next ? (
            <>
              next change: <span className="text-hi">{next.names.join(", ")}</span> {next.when}
            </>
          ) : (
            "next change: none scheduled"
          )}
        </p>
        <p>
          {hasLocation ? (
            `location ${loc.latitude!.toFixed(2)}, ${loc.longitude!.toFixed(2)} · ${formatZone(loc)}`
          ) : (
            <>
              no location set — sun rules will not run.{" "}
              <Link href="/settings" className="text-hi underline underline-offset-2">
                Set one in Settings
              </Link>
            </>
          )}
        </p>
      </div>
    </Panel>
  );
}
