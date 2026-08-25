"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  CalendarClock,
  RefreshCw,
  Search,
  Settings,
  Terminal,
} from "lucide-react";

import { IconButton, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import type { DeviceSummary } from "@/lib/api";
import { useDevices, useGroups, useHealth } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn, staggerParent } from "@/lib/motion";
import { DevicePlate } from "@/components/device/device-plate";
import { GroupsSection } from "@/components/device/groups-section";

/* ==================================================================
   Console — the live dashboard.
   Device plates render the same faithful instruments as the device
   console (mini variant), carry quick color/temperature controls, and
   read polled state through the intent ledger so a lagging cloud can
   never visibly undo a command. Groups broadcast real commands.
   ================================================================== */

const NAV_ITEMS = [
  { href: "/", label: "Console", icon: Terminal, active: true },
  { href: "/schedules", label: "Schedules", icon: CalendarClock, active: false },
  { href: "/settings", label: "Settings", icon: Settings, active: false },
] as const;

function Rail({ devices }: { devices: DeviceSummary[] }) {
  return (
    <aside className="hidden w-[220px] shrink-0 flex-col border-r border-hairline bg-panel md:flex">
      <nav className="flex flex-col gap-0.5 p-3">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] transition-colors duration-150",
              item.active
                ? "bg-accent-dim text-hi"
                : "text-mid hover:bg-accent-dim hover:text-hi",
            )}
          >
            <item.icon size={15} strokeWidth={1.5} aria-hidden />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="border-t border-hairline px-3 pt-4">
        <p className="px-2.5 pb-2 text-[11px] uppercase tracking-micro text-low">
          devices
        </p>
        <div className="flex flex-col gap-0.5">
          {devices.map((d) => (
            <Link
              key={d.id}
              href={`/device/${encodeURIComponent(d.ref)}`}
              className="flex items-center gap-2.5 rounded-btn px-2.5 py-1.5 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
            >
              <StatusDot tone={d.online === false ? "off" : "ok"} />
              <span className="truncate">{d.name ?? d.ref}</span>
              <span className="ml-auto font-mono text-[10px] text-low">
                {d.model}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <RailFooter />
    </aside>
  );
}

function RailFooter() {
  const groups = useGroups();
  const names = Object.keys(groups.data ?? {});

  return (
    <div className="mt-auto border-t border-hairline p-3">
      {names.map((name) => (
        <GroupRailButton key={name} name={name} />
      ))}
      {names.length === 0 && !groups.isLoading ? (
        <p className="px-2.5 py-2 font-mono text-[10px] leading-relaxed text-low">
          no groups — create one in settings
        </p>
      ) : null}
    </div>
  );
}

function GroupRailButton({ name }: { name: string }) {
  const groups = useGroups();
  const members = groups.data?.[name] ?? [];

  return (
    <button
      type="button"
      title={`${members.length} member${members.length === 1 ? "" : "s"}`}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
    >
      {name}
      <span className="ml-auto font-mono text-[10px] text-low">
        {members.length}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ page */

export default function ConsolePage() {
  const devices = useDevices();
  const health = useHealth();
  const [query, setQuery] = React.useState("");

  const list = devices.data ?? [];
  const filtered = query.trim()
    ? list.filter((d) =>
        `${d.name ?? ""} ${d.ref} ${d.model ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : list;

  const refreshAll = () => {
    void devices.refetch();
  };

  return (
    <>
      <Rail devices={list} />

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <motion.div
            variants={staggerParent}
            initial="hidden"
            animate="show"
            className="mx-auto max-w-[1080px] space-y-5 px-4 pb-16 pt-6 sm:px-6"
          >
            {/* head */}
            <motion.section variants={panelIn} className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold leading-tight tracking-[-0.02em] text-hi">
                  Console
                </h1>
                <p className="mt-1 font-mono text-[11px] text-low">
                  {devices.isLoading
                    ? "connecting…"
                    : `${list.length} devices · ${health.data?.mock ? "mock sidecar" : "live sidecar"} · v${health.data?.version ?? "?"}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="relative hidden sm:block">
                  <Search
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-low"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="filter devices…"
                    className="h-9 w-56 rounded-btn border border-hairline bg-raised pl-8 pr-3 text-[13px] text-hi transition-colors duration-150 placeholder:text-low focus-visible:border-hairline-strong focus-visible:outline-none"
                  />
                </label>
                <IconButton label="Refresh state" tooltip="Refresh state" onClick={refreshAll}>
                  <RefreshCw size={15} strokeWidth={1.5} className={devices.isFetching ? "animate-spin" : undefined} />
                </IconButton>
              </div>
            </motion.section>

            {/* error state */}
            {devices.isError ? (
              <Panel className="border-ember/40 p-5">
                <p className="text-[13px] font-medium text-hi">Sidecar unreachable</p>
                <p className="mt-1 font-mono text-[11px] text-mid">
                  Is the API running on 127.0.0.1:6057? Start it with GOVEE_WEBUI_MOCK=1 for demo data.
                </p>
              </Panel>
            ) : null}

            {/* device plates */}
            <motion.section variants={panelIn}>
              <SectionLabel title="devices" />
              <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {devices.isLoading
                  ? Array.from({ length: 3 }, (_, i) => (
                      <Panel key={i} className="p-4">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="mt-3 aspect-[4/3] w-full sm:aspect-[16/10]" />
                        <Skeleton className="mt-3.5 h-6 w-full" />
                      </Panel>
                    ))
                  : filtered.map((d) => <DevicePlate key={d.id} device={d} />)}
              </div>
              {!devices.isLoading && filtered.length === 0 && !devices.isError ? (
                <p className="mt-3 font-mono text-[11px] text-low">
                  no devices match &ldquo;{query}&rdquo;
                </p>
              ) : null}
            </motion.section>

            {/* groups */}
            <GroupsSection />
          </motion.div>
      </main>
    </>
  );
}

