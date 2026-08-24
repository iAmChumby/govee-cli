"use client";

import { motion } from "motion/react";

import { Chip, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import { useHealth } from "@/lib/queries";
import { panelIn } from "@/lib/motion";

import { ConfigRow } from "./field";

/**
 * Connection health: sidecar version, mock badge, scheduler status and
 * the polling cadence the UI runs at. Read-only.
 */
export function ConnectionSection() {
  const health = useHealth();

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
        ) : health.isError || !health.data ? (
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
            <ConfigRow label="scheduler">
              <span className="inline-flex items-center gap-2">
                <StatusDot tone={health.data.scheduler ? "ok" : "off"} />
                {health.data.scheduler ? "running" : "stopped"}
              </span>
            </ConfigRow>
            <ConfigRow label="polling">state 10s · health 60s</ConfigRow>
          </div>
        )}
      </Panel>
    </motion.section>
  );
}
