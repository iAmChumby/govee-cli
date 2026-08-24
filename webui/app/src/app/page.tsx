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

import {
  IconButton,
  Odometer,
  Panel,
  SectionLabel,
  Skeleton,
  Slider,
  StatusDot,
  Switch,
} from "@/components/ui";
import { DeviceStage } from "@/components/stage/stage";
import type { DeviceSummary } from "@/lib/api";
import {
  useDeviceControls,
  useDevices,
  useGroupRun,
  useGroupState,
  useGroups,
  useHealth,
  usePendingState,
} from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn, staggerParent } from "@/lib/motion";

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

/* ------------------------------------------------------------------ plate */

/** Compact temperature presets — inside every registered model's range. */
const TEMP_PRESETS = [2700, 4000, 6500] as const;

/** Six quick colors, shared with the device console's paint palette. */
const QUICK_COLORS = [
  "#FF4545",
  "#FFA53D",
  "#FFD23D",
  "#46D06A",
  "#3D7BFF",
  "#EAF2FF",
] as const;

function DevicePlate({ device }: { device: DeviceSummary }) {
  const controls = useDeviceControls();
  const pending = usePendingState(device.ref);
  const [scrub, setScrub] = React.useState<number | null>(null);
  const brightness = scrub ?? device.brightness ?? 0;
  const name = device.name ?? device.ref;

  const commitBrightness = (value: number) => {
    setScrub(null);
    if (value !== device.brightness) {
      void controls.brightness({ ref: device.ref, vars: value });
    }
  };

  return (
    <Panel className="p-4">
      <div className="flex items-center gap-2">
        <StatusDot tone={device.online === false ? "off" : "ok"} />
        <Link
          href={`/device/${encodeURIComponent(device.ref)}`}
          className="truncate text-[13px] font-medium leading-none text-hi hover:underline hover:underline-offset-4"
        >
          {name}
        </Link>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-low">
          {device.model}
        </span>
        <Switch
          checked={device.power === true}
          onCheckedChange={(on) => void controls.power({ ref: device.ref, vars: on })}
          ariaLabel={`Power ${name}`}
          pending={pending}
        />
      </div>

      {/* live instrument — tap through to the full console */}
      <Link
        href={`/device/${encodeURIComponent(device.ref)}`}
        aria-label={`Open ${name} console`}
        className="group/stage mt-3 block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <DeviceStage
          state={device}
          variant="mini"
          className="h-28 transition-colors duration-200 group-hover/stage:border-hairline-strong"
        />
      </Link>

      <div className="mt-3.5">
        <Slider
          value={brightness}
          min={1}
          max={100}
          onValueChange={setScrub}
          onValueCommit={commitBrightness}
          ariaLabel={`${name} brightness`}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-low">
        <Odometer value={brightness} pad={3} suffix="%" className="text-mid" />
        <span className="flex items-center gap-1.5">
          {device.color ? (
            <>
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-chip border border-hairline"
                style={{ background: device.color.hex }}
              />
              {device.color.hex.toUpperCase()}
            </>
          ) : device.color_temp_k ? (
            `${device.color_temp_k}K`
          ) : (
            "—"
          )}
        </span>
      </div>

      {/* quick set — per-light color + temperature without leaving the console */}
      <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2 border-t border-hairline pt-3">
        {QUICK_COLORS.map((hex) => {
          const active = device.color?.hex.toUpperCase() === hex;
          return (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={`Set ${name} to ${hex}`}
              aria-pressed={active}
              onClick={() => void controls.color({ ref: device.ref, vars: hex })}
              className={cn(
                "h-6 w-6 shrink-0 cursor-pointer rounded-chip border border-hairline transition-all duration-150 hover:scale-110 hover:border-hairline-strong active:scale-95",
                active && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
              )}
              style={{ background: hex }}
            />
          );
        })}
        <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />
        <span className="flex items-center gap-1.5">
          {TEMP_PRESETS.map((kelvin) => {
            const active = device.color_temp_k === kelvin;
            return (
              <button
                key={kelvin}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  void controls.temperature({ ref: device.ref, vars: kelvin })
                }
                className={cn(
                  "shrink-0 cursor-pointer rounded-chip border px-1.5 py-1 font-mono text-[10px] leading-none transition-colors duration-150",
                  active
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-low hover:border-hairline-strong hover:text-hi",
                )}
              >
                {kelvin}
              </button>
            );
          })}
        </span>
      </div>
    </Panel>
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
                        <Skeleton className="mt-3 h-28 w-full" />
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

/* ----------------------------------------------------------------- groups */

function GroupsSection() {
  const groups = useGroups();
  const names = Object.keys(groups.data ?? {});
  const [selected, setSelected] = React.useState<string | null>(null);

  const active =
    selected && names.includes(selected) ? selected : names[0] ?? null;
  const state = useGroupState(active);

  return (
    <motion.section variants={panelIn}>
      <SectionLabel title="groups" />
      {names.length === 0 ? (
        <p className="mt-3 font-mono text-[11px] text-low">
          no groups configured — add one under settings
        </p>
      ) : (
        <Panel className="p-5">
          <div className="flex flex-wrap gap-2">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSelected(name)}
                className={cn(
                  "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-150",
                  active === name
                    ? "border-hairline-strong bg-accent-dim text-hi"
                    : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                )}
              >
                {name}
              </button>
            ))}
          </div>

          <ul className="mt-4 divide-y divide-hairline">
            {(state.data?.devices ?? []).map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2.5">
                <StatusDot tone={d.online === false ? "off" : "ok"} />
                <span className="text-[13px] text-hi">{d.name ?? d.ref}</span>
                <span className="ml-auto font-mono text-[11px] text-low">
                  {d.power ? "on" : "off"} · {d.brightness ?? "?"}%
                </span>
                {d.color ? (
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-chip border border-hairline"
                    style={{ background: d.color.hex }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {(state.data?.errors ?? []).map((e) => (
            <p key={e.ref} className="py-1 font-mono text-[11px] text-ember">
              {e.ref}: {e.message}
            </p>
          ))}

          {active ? <GroupBroadcast name={active} members={state.data?.devices.map((d) => d.ref) ?? []} /> : null}
        </Panel>
      )}
    </motion.section>
  );
}

/** Broadcast controls — real `group run` commands, one tap for the room. */
function GroupBroadcast({ name, members }: { name: string; members: string[] }) {
  const run = useGroupRun();
  const [scrub, setScrub] = React.useState<number | null>(null);

  const fire = (command: string) =>
    void run({ name, vars: { command, members } });

  return (
    <div className="mt-4 space-y-3 border-t border-hairline pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-micro text-low">
          broadcast
        </span>
        <button
          type="button"
          onClick={() => fire("power on")}
          className="cursor-pointer rounded-btn border border-hairline px-3 py-1.5 text-[12px] text-hi transition-colors duration-150 hover:border-hairline-strong hover:bg-accent-dim"
        >
          all on
        </button>
        <button
          type="button"
          onClick={() => fire("power off")}
          className="cursor-pointer rounded-btn border border-hairline px-3 py-1.5 text-[12px] text-hi transition-colors duration-150 hover:border-hairline-strong hover:bg-accent-dim"
        >
          all off
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {QUICK_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              title={`Group color ${hex}`}
              aria-label={`Set group color ${hex}`}
              onClick={() => fire(`color ${hex.replace("#", "")}`)}
              className="h-6 w-6 shrink-0 cursor-pointer rounded-chip border border-hairline transition-all duration-150 hover:scale-110 hover:border-hairline-strong active:scale-95"
              style={{ background: hex }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          value={scrub ?? 50}
          min={1}
          max={100}
          onValueChange={setScrub}
          onValueCommit={(value) => {
            setScrub(null);
            fire(`brightness ${value}`);
          }}
          ariaLabel={`${name} group brightness`}
          className="max-w-[280px] flex-1"
        />
        <span className="font-mono text-[10px] text-low">
          {scrub !== null ? `${scrub}%` : "drag to set all"}
        </span>
      </div>
    </div>
  );
}
