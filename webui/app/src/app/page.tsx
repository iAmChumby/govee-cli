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
  Chip,
  IconButton,
  Odometer,
  Panel,
  SectionLabel,
  Skeleton,
  Slider,
  StatusDot,
  Switch,
} from "@/components/ui";
import type { DeviceSummary } from "@/lib/api";
import {
  useDeviceControls,
  useDevices,
  useGroupState,
  useGroups,
  useHealth,
} from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn, staggerParent } from "@/lib/motion";

/* ==================================================================
   Console — the live dashboard.
   Device plates read polled state; controls are optimistic mutations.
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

      <RailFooter devices={devices} />
    </aside>
  );
}

function RailFooter({ devices }: { devices: DeviceSummary[] }) {
  const groups = useGroups();
  const names = Object.keys(groups.data ?? {});

  return (
    <div className="mt-auto border-t border-hairline p-3">
      {names.map((name) => (
        <GroupRailButton key={name} name={name} devices={devices} />
      ))}
      {names.length === 0 && !groups.isLoading ? (
        <p className="px-2.5 py-2 font-mono text-[10px] leading-relaxed text-low">
          no groups — create one in settings
        </p>
      ) : null}
    </div>
  );
}

function GroupRailButton({
  name,
  devices,
}: {
  name: string;
  devices: DeviceSummary[];
}) {
  const groups = useGroups();
  const members = groups.data?.[name] ?? [];
  const online = members.filter((id) =>
    devices.some((d) => d.id === id && d.online !== false),
  ).length;

  return (
    <button
      type="button"
      title={`${online}/${members.length} online`}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
    >
      {name}
      <span className="ml-auto font-mono text-[10px] text-low">
        {members.length}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ stage */

/** Whole-device color as a zone strip; per-segment colors are not reported
 * by the cloud, so the strip interprets the single color across zones. */
function MiniStage({
  device,
  power,
}: {
  device: DeviceSummary;
  power: boolean;
}) {
  const hueSat = React.useMemo(() => {
    if (!device.color) return null;
    const [r, g, b] = device.color.rgb;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r / 255) h = ((g - b) / 255 / d) % 6;
    else if (max === g / 255) h = ((b - r) / 255 / d) + 2;
    else h = ((r - g) / 255 / d) + 4;
    return { h: ((h * 60) + 360) % 360, s: s * 100, l };
  }, [device.color]);

  const glow = springGlow(power, device.brightness ?? 50);
  const bodyOpacity = glow === 0 ? 0.07 : Math.min(1, 0.25 + glow * 0.75);
  const isOrb = !device.model || !hasZones(device);

  return (
    <div
      className="relative mt-3 h-24 overflow-hidden rounded-card border border-hairline bg-raised"
      role="img"
      aria-label={`${device.name ?? device.ref} preview`}
    >
      {hueSat && power ? (
        <>
          <div
            aria-hidden
            className="absolute inset-x-8 -top-10 h-24 blur-2xl transition-opacity duration-500"
            style={{
              opacity: glow * 0.9,
              background: `radial-gradient(closest-side, hsl(${hueSat.h} ${hueSat.s}% 62% / 0.9), transparent)`,
            }}
          />
          {isOrb ? (
            <div
              aria-hidden
              className="absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full border border-hairline-strong transition-opacity duration-500"
              style={{
                opacity: bodyOpacity,
                background: `radial-gradient(circle at 35% 30%, hsl(${hueSat.h} ${hueSat.s}% 88%), hsl(${hueSat.h} ${hueSat.s}% 55%))`,
              }}
            />
          ) : (
            <div aria-hidden className="absolute inset-x-4 bottom-4 flex gap-[3px]" style={{ opacity: bodyOpacity }}>
              {Array.from({ length: zoneCount(device) }, (_, i) => {
                const t = i / Math.max(zoneCount(device) - 1, 1);
                const l = Math.max(hueSat.l * 100, 30) - t * 14;
                return (
                  <div
                    key={i}
                    className="h-12 flex-1 rounded-[2px]"
                    style={{ background: `hsl(${hueSat.h} ${hueSat.s}% ${l}%)` }}
                  />
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div
          aria-hidden
          className="absolute inset-x-4 bottom-4 flex h-12 items-end gap-[3px]"
        >
          {Array.from({ length: isOrb ? 1 : zoneCount(device) }, (_, i) => (
            <div key={i} className="h-full flex-1 rounded-[2px] bg-accent-dim" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Brightness as a 0..1 glow factor, eased so low values stay visible. */
function springGlow(power: boolean, brightness: number): number {
  if (!power) return 0;
  return 0.25 + 0.75 * (brightness / 100);
}

const ZONE_MODELS: Record<string, number> = { H6056: 6, H6022: 15 };

function hasZones(d: DeviceSummary): boolean {
  return (d.model && ZONE_MODELS[d.model] !== undefined) || false;
}

function zoneCount(d: DeviceSummary): number {
  return (d.model && ZONE_MODELS[d.model]) || 1;
}

/* ------------------------------------------------------------------ plate */

function DevicePlate({ device }: { device: DeviceSummary }) {
  const controls = useDeviceControls();
  const [scrub, setScrub] = React.useState<number | null>(null);
  const brightness = scrub ?? device.brightness ?? 0;

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
          {device.name ?? device.ref}
        </Link>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-low">
          {device.model}
        </span>
        <Switch
          checked={device.power === true}
          onCheckedChange={(on) => void controls.power({ ref: device.ref, vars: on })}
          ariaLabel={`Power ${device.name ?? device.ref}`}
        />
      </div>

      <MiniStage device={device} power={device.power === true} />

      <div className="mt-3.5">
        <Slider
          value={brightness}
          min={1}
          max={100}
          onValueChange={setScrub}
          onValueCommit={commitBrightness}
          ariaLabel={`${device.name ?? device.ref} brightness`}
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
            className="mx-auto max-w-[1080px] space-y-5 px-6 pb-16 pt-6"
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
              <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {devices.isLoading
                  ? Array.from({ length: 3 }, (_, i) => (
                      <Panel key={i} className="p-4">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="mt-3 h-24 w-full" />
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

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Chip>poll 10s</Chip>
            <span className="font-mono text-[10px] text-low">
              broadcast controls live on each device console
            </span>
          </div>
        </Panel>
      )}
    </motion.section>
  );
}
