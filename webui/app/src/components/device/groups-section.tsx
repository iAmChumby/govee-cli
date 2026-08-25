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
                  // WEBUI_V3_SPEC.md §11.6: this chip is the control that
                  // selects a group, measured 97x29 at 390px — 29px tall is
                  // under the 44px touch-target floor even though its 97px
                  // width already clears it. `pointer-coarse:` grows only
                  // the missing dimension (min-h + vertical centering); the
                  // width floor is a defensive match for short group names,
                  // same reasoning as device-plate.tsx's name-Link fix. Both
                  // are inert with a mouse, so desktop's 97x29 box is
                  // unchanged (§11.1).
                  "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-150 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center",
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
        {/* WEBUI_V3_SPEC.md §11.6: measured 56x32 / 55x32 at 390px — width
            already clears 44px, height doesn't. `pointer-coarse:` floors
            height and re-centers the label (a plain button has no flex
            centering by default, so a bare min-h would leave the text
            pinned to the top of the taller box); inert with a mouse, so
            desktop's 32px-tall box is unchanged (§11.1). */}
        <button
          type="button"
          onClick={() => fire("power on")}
          className="cursor-pointer rounded-btn border border-hairline px-3 py-1.5 text-[12px] text-hi transition-colors duration-150 hover:border-hairline-strong hover:bg-accent-dim pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center"
        >
          all on
        </button>
        <button
          type="button"
          onClick={() => fire("power off")}
          className="cursor-pointer rounded-btn border border-hairline px-3 py-1.5 text-[12px] text-hi transition-colors duration-150 hover:border-hairline-strong hover:bg-accent-dim pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center"
        >
          all off
        </button>
        {/* Quick-colour swatches broadcast one colour to every device in the
            group — 24x24, well under 44px. Copies device-plate.tsx's
            channel-strip dock pattern (§11.6 comment there): grow the HIT
            AREA in a separate wrapper `<button>`, not the ink, so the
            circle still reads as 24px. Unlike that dock this row isn't a
            horizontal-scroll strip — it sits in a plain flex row that can
            wrap — so the box only grows `pointer-coarse:`, never
            unconditionally, or six 44px boxes would reflow this row at
            desktop too and fail the baseline (§11.1). `pointer-coarse:gap-2`
            widens the space between the now-44px hit boxes so adjacent taps
            can't clip a neighbour; at mouse size the boxes are still exactly
            24px apart via the base `gap-1.5`, unchanged from before. */}
        <div className="ml-auto flex items-center gap-1.5 pointer-coarse:gap-2">
          {QUICK_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              title={`Group color ${hex}`}
              aria-label={`Set group color ${hex}`}
              onClick={() => fire(`color ${hex.replace("#", "")}`)}
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-chip pointer-coarse:h-11 pointer-coarse:w-11"
            >
              <span
                aria-hidden
                className="block h-6 w-6 rounded-chip border border-hairline transition-all duration-150 hover:scale-110 hover:border-hairline-strong active:scale-95"
                style={{ background: hex }}
              />
            </button>
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
