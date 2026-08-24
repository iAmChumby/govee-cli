"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import {
  Button,
  Chip,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";
import { ApiError, api, type DeviceSummary } from "@/lib/api";
import { useApplyMutation, useDevices } from "@/lib/queries";
import { cn } from "@/lib/cn";

import { Field, INPUT_CLASS } from "./field";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const QUICK_COMMANDS = ["power on", "power off", "brightness 50", "scene sunset"] as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface ScheduleDraft {
  name: string;
  time: string;
  days: string[];
  command: string;
  device: string;
}

type FieldErrors = Partial<Record<"name" | "time" | "days" | "command" | "form", string>>;

const EMPTY_DRAFT: ScheduleDraft = { name: "", time: "", days: [], command: "", device: "" };

function validate(draft: ScheduleDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.name.trim()) errors.name = "give the rule a name";
  if (!TIME_PATTERN.test(draft.time)) errors.time = "time must be HH:MM (24h)";
  if (draft.days.length === 0) errors.days = "pick at least one day";
  if (!draft.command.trim()) errors.command = "what should run — e.g. power on";
  return errors;
}

/** Toggle chip shared by the day picker and command quick-picks. */
function ToggleChip({
  active,
  onClick,
  children,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] transition-colors duration-150",
        active
          ? "border-hairline-strong bg-accent-dim text-hi"
          : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Add-rule sheet: name, time, weekday chips, command with quick-picks and
 * an optional target device. Client-side validation mirrors the sidecar
 * schema; server ApiError messages surface in the form error slot.
 */
export function AddRuleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const devices = useDevices();
  const [draft, setDraft] = React.useState<ScheduleDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [submitting, setSubmitting] = React.useState(false);

  const createRule = useApplyMutation<ScheduleDraft>(
    "schedule",
    ({ vars }) =>
      api.createSchedule({
        name: vars.name.trim(),
        time: vars.time,
        days: vars.days,
        command: vars.command.trim(),
        ...(vars.device ? { device: vars.device } : {}),
      }),
    (vars) => `${vars.name.trim()} · ${vars.time}`,
  );

  const setField = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (key !== "device") setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const toggleDay = (day: string) => {
    setDraft((prev) => ({
      ...prev,
      days: prev.days.includes(day)
        ? prev.days.filter((d) => d !== day)
        : [...prev.days, day],
    }));
    setErrors((prev) => ({ ...prev, days: undefined }));
  };

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate(draft);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    setSubmitting(true);
    try {
      await createRule({ ref: draft.device, vars: draft });
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setDraft(EMPTY_DRAFT);
      onOpenChange(false);
    } catch (err) {
      // useApplyMutation already toasted; also surface the message in-form
      if (err instanceof ApiError) {
        setErrors((prev) => ({ ...prev, form: err.message }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrors({});
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>new rule</DialogTitle>
        <DialogDescription>
          runs one command at a fixed time on the chosen weekdays.
        </DialogDescription>

        <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
          <Field label="name" error={errors.name}>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="weekday sunrise"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <Field label="time" error={errors.time}>
              <input
                type="time"
                value={draft.time}
                onChange={(e) => setField("time", e.target.value)}
                className={cn(INPUT_CLASS, "font-mono text-[12px]")}
              />
            </Field>

            <Field label="days" error={errors.days}>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {DAYS.map((day) => (
                  <ToggleChip
                    key={day}
                    active={draft.days.includes(day)}
                    onClick={() => toggleDay(day)}
                    ariaLabel={`${draft.days.includes(day) ? "Remove" : "Add"} ${day}`}
                  >
                    {day}
                  </ToggleChip>
                ))}
              </div>
            </Field>
          </div>

          <Field label="command" error={errors.command} hint="same verbs as govee-cli power/brightness/color/temp/scene">
            <input
              type="text"
              value={draft.command}
              onChange={(e) => setField("command", e.target.value)}
              placeholder="power on"
              spellCheck={false}
              autoComplete="off"
              className={cn(INPUT_CLASS, "font-mono text-[12px]")}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK_COMMANDS.map((cmd) => (
                <ToggleChip
                  key={cmd}
                  active={draft.command === cmd}
                  onClick={() => setField("command", cmd)}
                  ariaLabel={`Use command ${cmd}`}
                >
                  {cmd}
                </ToggleChip>
              ))}
            </div>
          </Field>

          <Field label="target device" hint="omit to fire against the config default device">
            <span className="relative block">
              <select
                value={draft.device}
                onChange={(e) => setField("device", e.target.value)}
                className={cn(INPUT_CLASS, "cursor-pointer appearance-none pr-8 font-mono text-[12px]")}
              >
                <option value="">(default device)</option>
                {(devices.data ?? []).map((d: DeviceSummary) => (
                  <option key={d.id} value={d.id}>
                    {d.name ?? d.ref}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={13}
                strokeWidth={1.5}
                aria-hidden
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-low"
              />
            </span>
          </Field>

          {errors.form ? (
            <p role="alert" className="font-mono text-[11px] leading-snug text-ember">
              {errors.form}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button variant="ghost">cancel</Button>
            </DialogClose>
            <Button type="submit" variant="solid" busy={submitting}>
              create rule
            </Button>
          </div>
        </form>

        {/* quiet footer note keeps the dialog from feeling bare */}
        <p className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 font-mono text-[10px] text-low">
          <Chip>hint</Chip> disabled rules keep their schedule but never fire
        </p>
      </DialogContent>
    </Dialog>
  );
}
