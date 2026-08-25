"use client";

import { motion } from "motion/react";

import { Chip, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import { useHealth } from "@/lib/queries";
import { panelIn } from "@/lib/motion";

import { ConfigRow } from "./field";

function formatAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Connection health: sidecar version, mock badge, the full scheduler
 * breakdown (WEBUI_V3_SPEC.md §6.5 — this is the "detail view" the status
 * strip's one compact dot points at) and the polling cadence the UI runs
 * at. Read-only.
 *
 * `Health.scheduler` is `{native, external}`, not the flat boolean this
 * page used to render — `native` is the sidecar's own embedded poll
 * runner (fires `ScheduleRule`s), `external` is what it knows about
 * crontab-driven automation it has no control over (wake-ramp, etc.).
 * Both get an honest tri-state where the data itself is tri-state —
 * `wake_ramp_armed` is `boolean | null`, and `null` is rendered literally
 * as "unknown," never folded into "not armed."
 */
export function ConnectionSection() {
  const health = useHealth();
  const scheduler = health.data?.scheduler;

  return (
    <motion.section variants={panelIn}>
      <SectionLabel index={1} title="connection" />
      <Panel className="mt-3 p-5">
        {health.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-40" />
          </div>
        ) : health.isError || !health.data || !scheduler ? (
          <p className="py-1 font-mono text-[11px] leading-relaxed text-low">
            sidecar unreachable — is the API running on 127.0.0.1:6057?
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            <ConfigRow label="status">{health.data.status}</ConfigRow>
            <ConfigRow label="sidecar version">v{health.data.version}</ConfigRow>
            <ConfigRow label="mode">
              <Chip>{health.data.mock ? "mock" : "live"}</Chip>
            </ConfigRow>

            {/* native — the sidecar's own embedded rule runner */}
            <ConfigRow label="native scheduler">
              <span className="inline-flex items-center gap-2">
                <StatusDot tone={scheduler.native.alive ? "ok" : "warn"} />
                {scheduler.native.alive ? "running" : "stopped"}
              </span>
            </ConfigRow>
            <ConfigRow label="poll interval">
              {scheduler.native.poll_seconds !== null ? `${scheduler.native.poll_seconds}s` : "—"}
            </ConfigRow>
            <ConfigRow label="last cycle">{formatAgo(scheduler.native.last_cycle_at)}</ConfigRow>
            <ConfigRow label="last fire">
              {scheduler.native.last_fire ? (
                <span
                  className="inline-flex items-center gap-1.5"
                  title={scheduler.native.last_fire.error ?? undefined}
                >
                  <StatusDot tone={scheduler.native.last_fire.ok ? "ok" : "warn"} />
                  {scheduler.native.last_fire.name} · {formatAgo(scheduler.native.last_fire.at)}
                </span>
              ) : (
                "no rule has fired yet"
              )}
            </ConfigRow>

            {/* external — crontab-discovered automation the native runner
                can't see; §6.6 — an unreadable crontab is shown as such,
                never blurred into "0 automations". */}
            <ConfigRow label="crontab">
              <span className="inline-flex items-center gap-2">
                <StatusDot tone={scheduler.external.crontab_readable ? "ok" : "warn"} />
                {scheduler.external.crontab_readable ? "readable" : "unreadable"}
              </span>
            </ConfigRow>
            {!scheduler.external.crontab_readable && scheduler.external.error ? (
              <ConfigRow label="crontab error">{scheduler.external.error}</ConfigRow>
            ) : null}
            <ConfigRow label="wake-ramp armed">
              {scheduler.external.wake_ramp_armed === null
                ? "unknown"
                : scheduler.external.wake_ramp_armed
                  ? "armed"
                  : "not armed"}
            </ConfigRow>
            <ConfigRow label="external entries">{scheduler.external.entry_count}</ConfigRow>

            <ConfigRow label="polling">state 10s · health 60s</ConfigRow>
          </div>
        )}
      </Panel>
    </motion.section>
  );
}
