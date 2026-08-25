"use client";

/**
 * ModePicker — WEBUI_V3_SPEC.md §10 T27, "the unknown-mode chooser on the
 * stage".
 *
 * `active.mode === "unknown"` means the ledger (§3) has no record at all —
 * not "off", not "basic", nothing. The stage has nothing honest to caption
 * and no motion texture to draw for that state (`motionModeMetaFor` returns
 * `null`), so today it just falls back to a flat guessed color with no
 * label. This is the fix: a control that lets the person looking at the
 * actual light tell the console what it's doing, sourced from the device's
 * *real* scene/DIY/music option lists (not free text) so the corrected
 * label round-trips through the motion classifier afterward and the stage
 * actually starts animating.
 *
 * Load-bearing distinction, stated in the UI copy on purpose: this writes
 * the ledger only. `useSetActiveMode()` → `PUT .../active-mode` (T23) sends
 * **zero** commands to the device. A user who believes this button applies
 * a scene would mis-set the ledger — the exact honesty bug this console
 * exists to fix, running backwards.
 */

import * as React from "react";
import { HelpCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import type { ActiveModeKind } from "@/lib/api";
import { useDiyScenes, useMusicModes, useScenes, useSetActiveMode } from "@/lib/queries";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionLabel } from "@/components/ui/section-label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { springSnappy } from "@/lib/motion";

interface ModeOption {
  mode: ActiveModeKind;
  /** null only for the two fixed options, which carry no name of their own */
  label: string | null;
  hint: string;
  /** The identifiers the device actually needs to be driven back into this
   *  mode later, in the same shape the real apply routes record (§3.3):
   *  `{scene_id, param_id}`, `{diy_value}`, `{music_mode, sensitivity}`.
   *
   *  Carrying it is not optional decoration. A ledger entry written with a
   *  label but no payload looks complete on the stage and is complete for
   *  everything the stage does — but a room scene captures the ledger
   *  verbatim, and restoring one has to reissue a real command. Without these
   *  ids there is nothing to reissue, so a device corrected here would fail
   *  its own restore with "missing its value" while every device set through
   *  a normal command path restored fine. */
  payload?: Record<string, unknown>;
}

/** Always offered, regardless of what the device's cloud libraries hold —
 *  "unknown" can honestly resolve to either of these with no scene running
 *  at all. */
const FIXED_OPTIONS: ModeOption[] = [
  { mode: "basic", label: null, hint: "plain color" },
  { mode: "off", label: null, hint: "powered off" },
];

function optionKey(opt: ModeOption): string {
  return `${opt.mode}:${opt.label ?? ""}`;
}

function optionName(opt: ModeOption): string {
  if (opt.label) return opt.label;
  return opt.mode === "off" ? "off" : "basic";
}

export interface UnknownModeChooserProps {
  deviceRef: string;
}

/**
 * The stage's tap target for the `active.mode === "unknown"` branch
 * (stage.tsx) — deliberately the *inverse* render condition of
 * `ActiveModeReset`, which needs a known mode to reset FROM. This one
 * needs the absence of one to fix TOWARD.
 *
 * Tier (V3_VISUAL_DIRECTION.md §B): CONTROL-RESPONSE for the press
 * physics (springSnappy tap, same as every other control in this app) —
 * the trigger's resting appearance stays CHASSIS, a dashed neutral
 * outline with no device hue. Claiming a color for a mode nobody can
 * currently name would be a fabricated SIGNAL, which §B forbids; the same
 * restraint carries into the picker's option rows below.
 */
export function UnknownModeChooser({ deviceRef }: UnknownModeChooserProps) {
  const [open, setOpen] = React.useState(false);
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);
  const setActiveMode = useSetActiveMode();
  const reduced = useReducedMotion();

  // The device's real scene/DIY/music libraries are only fetched once the
  // picker is actually open — an unknown-mode card can sit around for a
  // long time, and pulling three extra endpoints for a dialog nobody has
  // opened yet would be exactly the kind of unmeasured traffic §10.1 warns
  // against.
  const liveRef = open ? deviceRef : null;
  const scenes = useScenes(liveRef);
  const diyScenes = useDiyScenes(liveRef);
  const music = useMusicModes(liveRef);

  const sceneOptions: ModeOption[] = React.useMemo(
    () =>
      (scenes.data?.scenes ?? []).map((s) => ({
        mode: "scene" as const,
        label: s.name,
        hint: "firmware scene",
        payload: { scene_id: s.scene_id, param_id: s.param_id },
      })),
    [scenes.data],
  );
  const diyOptions: ModeOption[] = React.useMemo(
    () =>
      (diyScenes.data ?? []).map((s) => ({
        mode: "diy" as const,
        label: s.name,
        hint: "DIY scene",
        payload: { diy_value: s.value },
      })),
    [diyScenes.data],
  );
  const musicOptions: ModeOption[] = React.useMemo(
    () =>
      (music.data?.modes ?? []).map((m) => ({
        mode: "music" as const,
        label: m.key,
        hint: "music mode",
        // sensitivity is genuinely unknown here — we are recording what the
        // user says is already playing, not choosing it — so it is left out
        // rather than defaulted, and the apply path fills it when someone
        // actually sets a music mode.
        payload: { music_mode: m.value },
      })),
    [music.data],
  );

  const listsLoading = liveRef !== null && (scenes.isLoading || diyScenes.isLoading || music.isLoading);
  const listsFailed =
    liveRef !== null &&
    !listsLoading &&
    scenes.isError &&
    diyScenes.isError &&
    music.isError;

  const choose = React.useCallback(
    (opt: ModeOption) => {
      const key = optionKey(opt);
      setPendingKey(key);
      void setActiveMode({
        ref: deviceRef,
        vars: { mode: opt.mode, label: opt.label, payload: opt.payload ?? null },
      })
        .then(() => setOpen(false))
        .finally(() => setPendingKey((cur) => (cur === key ? null : cur)));
    },
    [deviceRef, setActiveMode],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPendingKey(null);
      }}
    >
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Tell the console what's playing"
        title="Tell the console what's playing — this does not change the light"
        whileTap={reduced ? undefined : { scale: 0.95, transition: springSnappy }}
        // §11.3: this chip is the SOLE entry point for correcting an unknown
        // mode, and at h-6 (24px) it failed the 44px touch-target floor.
        //
        // The button grows to 44px under `pointer-coarse:`; the *painted*
        // chip does not. That split matters here more than anywhere else in
        // the app: this control is absolutely positioned ON TOP of the
        // instrument, which is SIGNAL-PRIME, and the first attempt at this
        // fix put the height on the element carrying the dashed border, the
        // background and the radius — so a 44px slab of chrome ended up
        // sitting over the lamp. §G forbids exactly that: chassis may be
        // rearranged or resized, never made louder. Screenshot review caught
        // it; the geometry gate could not, because both versions measure
        // 44px.
        //
        // Growing the button's own box (rather than layering an oversized
        // overlay) is safe here because the chip is absolutely positioned
        // over the stage canvas, with no flex siblings a taller box could
        // shove — and a fine-pointer desktop never evaluates the rule.
        className="group pointer-events-auto flex shrink-0 cursor-pointer items-center outline-none pointer-coarse:h-11"
      >
        <span className="flex h-6 items-center gap-1 rounded-chip border border-dashed border-hairline bg-bg/80 px-2 font-mono text-[9px] uppercase leading-none tracking-micro text-low transition-colors duration-150 group-hover:border-hairline-strong">
          <HelpCircle aria-hidden className="h-3 w-3 shrink-0" />
          what&rsquo;s playing?
        </span>
      </motion.button>

      <DialogContent>
        <DialogTitle>What&rsquo;s the light actually doing?</DialogTitle>
        <DialogDescription>
          The console has no record of this device&rsquo;s mode. Picking an
          option below only corrects what the console displays — it sends
          nothing to the light. Choose whatever is really playing so the
          stage stops guessing.
        </DialogDescription>

        <div className="mt-4 max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          <OptionGroup
            title="basics"
            options={FIXED_OPTIONS}
            pendingKey={pendingKey}
            busy={pendingKey !== null}
            onChoose={choose}
          />

          {listsLoading ? (
            <div className="flex items-center gap-2 py-2 font-mono text-[11px] text-low">
              <Spinner /> loading this device&rsquo;s real scene/DIY/music lists…
            </div>
          ) : null}

          {sceneOptions.length > 0 ? (
            <OptionGroup
              title={`scenes (${sceneOptions.length})`}
              options={sceneOptions}
              pendingKey={pendingKey}
              busy={pendingKey !== null}
              onChoose={choose}
            />
          ) : null}

          {diyOptions.length > 0 ? (
            <OptionGroup
              title={`DIY scenes (${diyOptions.length})`}
              options={diyOptions}
              pendingKey={pendingKey}
              busy={pendingKey !== null}
              onChoose={choose}
            />
          ) : null}

          {musicOptions.length > 0 ? (
            <OptionGroup
              title={`music modes (${musicOptions.length})`}
              options={musicOptions}
              pendingKey={pendingKey}
              busy={pendingKey !== null}
              onChoose={choose}
            />
          ) : null}

          {listsFailed ? (
            <p className="font-mono text-[11px] leading-snug text-low">
              couldn&rsquo;t load this device&rsquo;s scene/DIY/music libraries —
              basic and off are still available above.
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end border-t border-hairline pt-3">
          <DialogClose asChild>
            <button
              type="button"
              // Kept as a raw <button>, not the shared `Button` component
              // (T36 brief) — swapping it would change its desktop size,
              // which this file does not own the blast radius for.
              // `pointer-coarse:` bumps it past the 44px floor via padding
              // alone; the fine-pointer geometry (px-3 py-1.5, ~26-28px) is
              // untouched.
              className="rounded-btn border border-hairline px-3 py-1.5 font-medium uppercase tracking-[0.08em] text-[10px] text-mid transition-colors duration-150 hover:border-hairline-strong hover:text-hi pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:py-3"
            >
              cancel
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OptionGroup({
  title,
  options,
  pendingKey,
  busy,
  onChoose,
}: {
  title: string;
  options: ModeOption[];
  pendingKey: string | null;
  busy: boolean;
  onChoose: (opt: ModeOption) => void;
}) {
  return (
    <div>
      <SectionLabel title={title} />
      <ul className="mt-2 space-y-1">
        {options.map((opt) => {
          const key = optionKey(opt);
          return (
            <li key={key}>
              <OptionRow
                opt={opt}
                pending={pendingKey === key}
                disabled={busy}
                onChoose={onChoose}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A single choosable option. No color of any kind — same restraint the
 * trigger itself keeps (§B "no fabricated SIGNAL"), since none of these
 * options is a color we've actually confirmed the device is showing.
 */
function OptionRow({
  opt,
  pending,
  disabled,
  onChoose,
}: {
  opt: ModeOption;
  pending: boolean;
  disabled: boolean;
  onChoose: (opt: ModeOption) => void;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={() => onChoose(opt)}
      whileTap={disabled || reduced ? undefined : { scale: 0.98, transition: springSnappy }}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-card border border-hairline bg-raised px-3 py-2 text-left transition-colors duration-150 hover:border-hairline-strong",
        // px-3 py-2 plus one line of 12px text lands under 44px — the same
        // gap every other picker row in this app has under pointer-coarse.
        // min-h (not h-) so a long scene name that wraps still grows.
        "pointer-coarse:min-h-11",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      <span className="truncate text-[12px] text-hi">{optionName(opt)}</span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase leading-none tracking-[0.08em] text-low">
        {pending ? <Spinner /> : null}
        {opt.hint}
      </span>
    </motion.button>
  );
}
