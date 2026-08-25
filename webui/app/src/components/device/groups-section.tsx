"use client";

import * as React from "react";
import { motion } from "motion/react";

import { Panel, SectionLabel, Slider, StatusDot } from "@/components/ui";
import {
  useGroupRun,
  useGroupState,
  useGroups,
} from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn } from "@/lib/motion";
import { QUICK_COLORS } from "@/components/device/device-plate";

/* ==================================================================
   GroupsSection — the dashboard's broadcast panel (extracted from
   page.tsx). CHASSIS per V3_VISUAL_DIRECTION.md §B: a group represents
   several devices at once, not one live color, so it deliberately does
   not opt into `.dev-bleed` — averaging member colors into one tint
   would be exactly the dishonest "muddy purple" §C rules out.
   ================================================================== */

export function GroupsSection() {
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

          {active ? (
            <GroupBroadcast
              name={active}
              members={state.data?.devices.map((d) => d.ref) ?? []}
            />
          ) : null}
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
