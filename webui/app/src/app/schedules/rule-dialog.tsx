"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Minus, Plus, TriangleAlert } from "lucide-react";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Pressable,
  Select,
} from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, api, type DeviceSummary, type ScheduleRule } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDevices, useRooms, useSaveSchedule, useSchedulePreview } from "@/lib/queries";
import { formatRunAt, formatZone, wallHM } from "@/lib/schedule-format";

import { Field, INPUT_CLASS } from "./field";
import {
  type WhenKind,
  formatWhen,
  isSun,
  offsetLabel,
  parseWhen,
  stepOffset,
} from "./when";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const QUICK_COMMANDS = ["power on", "power off", "brightness 50", "scene sunset"] as const;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

type TargetKind = "device" | "room";

interface Draft {
  name: string;
  kind: WhenKind;
  clock: string;
  offsetMinutes: number;
  days: string[];
  target: TargetKind;
  device: string;
  command: string;
  roomScene: string;
}

type Errors = Partial<Record<"name" | "time" | "days" | "command" | "room" | "form", string>>;

function draftFrom(rule: ScheduleRule | null): Draft {
  const blank: Draft = {
    name: "",
    kind: "clock",
    clock: "",
    offsetMinutes: 0,
    days: [...DAYS],
    target: "device",
    device: "",
    command: "",
    roomScene: "",
  };
  if (!rule) return blank;
  const when = parseWhen(rule.time);
  return {
    ...blank,
    name: rule.name,
    kind: when?.kind ?? "clock",
    clock: when?.kind === "clock" ? when.time : when ? "" : rule.time,
    offsetMinutes: when && when.kind !== "clock" ? when.offsetMinutes : 0,
    days: rule.days,
    target: rule.room_scene ? "room" : "device",
    device: rule.device ?? "",
    command: rule.command,
    roomScene: rule.room_scene ?? "",
  };
}

/** The canonical string the draft currently describes, or "" while incomplete. */
function whenString(d: Draft): string {
  if (d.kind === "clock") return CLOCK_PATTERN.test(d.clock) ? d.clock : "";
  return formatWhen({ kind: d.kind, offsetMinutes: d.offsetMinutes });
}

/* ---------------------------------------------------------- small controls */

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-1 rounded-btn border border-hairline bg-raised p-1"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-7 min-w-0 flex-1 cursor-pointer rounded-chip border font-mono text-micro uppercase tracking-caps transition-colors duration-motion-150 pointer-coarse:min-h-11",
              active
                ? "border-hairline-strong bg-accent-dim text-hi"
                : "border-transparent text-mid hover:text-hi",
            )}
          >
            {o.label}
          </Pressable>
        );
      })}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-btn border border-hairline bg-raised text-mid transition-colors duration-motion-150 hover:border-hairline-strong hover:text-hi pointer-coarse:h-11 pointer-coarse:w-11"
    >
      {children}
    </Pressable>
  );
}

function SelectBox({
  value,
  onChange,
  children,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <span className="relative block">
      <Select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          INPUT_CLASS,
          "cursor-pointer appearance-none pr-8 font-mono pointer-coarse:h-11",
        )}
      >
        {children}
      </Select>
      <ChevronDown
        size={13}
        strokeWidth={1.5}
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-low"
      />
    </span>
  );
}

/* ------------------------------------------------------------ resolved line */

function ResolvedLine({ draft, now }: { draft: Draft; now: string }) {
  const time = whenString(draft);
  const preview = useSchedulePreview(time, draft.days.length ? draft.days : [...DAYS], time !== "");
  const sun = isSun(draft.kind);

  if (time === "") return null;
  if (preview.isLoading) {
    return <p className="font-mono text-label text-low">resolving…</p>;
  }
  if (preview.isError || !preview.data) {
    return (
      <p className="font-mono text-data leading-snug text-low">
        could not resolve a time: the sidecar did not answer
      </p>
    );
  }
  const p = preview.data;
  if (p.error) {
    return (
      <p role="alert" className="flex items-start gap-1.5 font-mono text-data leading-snug text-ember">
        <TriangleAlert size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
        {p.error}
      </p>
    );
  }
  const noLocation = sun && (p.location.latitude === null || /location/i.test(p.reason ?? ""));
  if (noLocation) {
    return (
      <p className="font-mono text-data leading-snug text-mid">
        No location set: {draft.kind} times cannot be computed.{" "}
        <Link href="/settings" className="whitespace-nowrap text-hi underline underline-offset-2">
          Set it in Settings
        </Link>
      </p>
    );
  }
  const zone = <span className="whitespace-nowrap">{formatZone(p.location)}</span>;
  const detail = sun && p.event_time ? <>{`${draft.kind} ${wallHM(p.event_time)}, `}{zone}</> : zone;
  return (
    <div className="space-y-0.5 font-mono text-data leading-snug text-mid">
      <p>
        {p.today_fire
          ? <>{`Today: ${wallHM(p.today_fire)} (`}{detail})</>
          : <>{`Today: no run${p.reason ? ` (${p.reason})` : ""} (`}{detail})</>}
      </p>
      {p.next_run ? <p className="text-low">Next run: {formatRunAt(p.next_run, now)}</p> : null}
    </div>
  );
}

/* --------------------------------------------------------------------- form */

function RuleForm({
  rule,
  now,
  onDone,
}: {
  rule: ScheduleRule | null;
  now: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const devices = useDevices();
  const rooms = useRooms();
  const save = useSaveSchedule();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(rule));
  const [errors, setErrors] = React.useState<Errors>({});
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      toast({ variant: "ok", title: "Rule deleted", description: rule?.name });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      onDone();
    },
    onError: (err) => {
      setErrors({ form: err instanceof ApiError ? err.message : String(err) });
    },
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors({});
  };

  const toggleDay = (day: string) =>
    set(
      "days",
      draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day],
    );

  const scenes = rooms.data ?? [];
  const sceneInfo = scenes.find((s) => s.name === draft.roomScene);
  const deviceOptions: DeviceSummary[] = devices.data ?? [];
  const deviceKnown = draft.device === "" || deviceOptions.some((d) => d.id === draft.device);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Errors = {};
    if (!draft.name.trim()) found.name = "give the rule a name";
    if (draft.kind === "clock" && !CLOCK_PATTERN.test(draft.clock)) found.time = "time must be HH:MM (24h)";
    if (draft.days.length === 0) found.days = "pick at least one day";
    if (draft.target === "device" && !draft.command.trim()) found.command = "what should run, e.g. power on";
    if (draft.target === "room" && !draft.roomScene) found.room = "pick a room scene";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      await save.mutateAsync({
        id: rule?.id ?? null,
        body: {
          name: draft.name.trim(),
          time: whenString(draft),
          days: draft.days,
          command: draft.target === "device" ? draft.command.trim() : "",
          device: draft.target === "device" && draft.device ? draft.device : null,
          room_scene: draft.target === "room" ? draft.roomScene : null,
          enabled: rule?.enabled ?? true,
        },
      });
      toast({ variant: "ok", title: rule ? "Rule saved" : "Rule created", description: draft.name.trim() });
      onDone();
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : String(err) });
    }
  }

  return (
    <>
      <DialogTitle>{rule ? "edit rule" : "new rule"}</DialogTitle>
      <DialogDescription>
        {isSun(draft.kind)
          ? `fires relative to the day's ${draft.kind}, recomputed daily.`
          : "runs at a fixed clock time on the chosen weekdays."}
      </DialogDescription>

      <form onSubmit={submit} noValidate className="mt-5">
        {/* Body scrolls inside a height that clears the fixed status strip;
            the footer below stays put, so Cancel/Save are always visible. */}
        <div className="max-h-[calc(100dvh-17rem)] space-y-4 overflow-y-auto px-1 -mx-1">
        <Field label="name" error={errors.name}>
          <Input
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="weekday sunrise"
            autoComplete="off"
            className={cn(INPUT_CLASS, "pointer-coarse:h-11")}
          />
        </Field>

        <div className="space-y-2">
          <span className="block text-label uppercase leading-none tracking-micro text-mid">when</span>
          <Segmented<WhenKind>
            label="When"
            value={draft.kind}
            onChange={(v) => set("kind", v)}
            options={[
              { value: "clock", label: "Clock" },
              { value: "sunrise", label: "Sunrise" },
              { value: "sunset", label: "Sunset" },
            ]}
          />
          {draft.kind === "clock" ? (
            <div>
              <Input
                type="time"
                aria-label="Clock time"
                value={draft.clock}
                onChange={(e) => set("clock", e.target.value)}
                className={cn(INPUT_CLASS, "font-mono pointer-coarse:h-11")}
              />
              {errors.time ? (
                <span role="alert" className="mt-1.5 block font-mono text-data leading-snug text-ember">
                  {errors.time}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <StepButton
                label="15 minutes earlier"
                onClick={() => set("offsetMinutes", stepOffset(draft.offsetMinutes, -1))}
              >
                <Minus size={14} strokeWidth={1.75} aria-hidden />
              </StepButton>
              <span
                aria-live="polite"
                className="min-w-0 flex-1 text-center font-mono text-data tabular-nums text-hi"
              >
                {offsetLabel(draft.kind, draft.offsetMinutes)}
              </span>
              <StepButton
                label="15 minutes later"
                onClick={() => set("offsetMinutes", stepOffset(draft.offsetMinutes, 1))}
              >
                <Plus size={14} strokeWidth={1.75} aria-hidden />
              </StepButton>
            </div>
          )}
          <ResolvedLine draft={draft} now={now} />
        </div>

        <div>
          <span className="mb-1.5 block text-label uppercase leading-none tracking-micro text-mid">days</span>
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((day) => {
              const on = draft.days.includes(day);
              return (
                <Pressable
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${on ? "Remove" : "Add"} ${day}`}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "h-8 min-w-0 cursor-pointer rounded-chip border px-0 font-mono text-micro uppercase leading-none tracking-data transition-colors duration-motion-150 pointer-coarse:h-11",
                    on
                      ? "border-hairline-strong bg-accent-dim text-hi"
                      : "border-hairline text-low hover:border-hairline-strong hover:text-hi",
                  )}
                >
                  {day}
                </Pressable>
              );
            })}
          </div>
          {errors.days ? (
            <span role="alert" className="mt-1.5 block font-mono text-data leading-snug text-ember">
              {errors.days}
            </span>
          ) : null}
        </div>

        <div className="space-y-2">
          <span className="block text-label uppercase leading-none tracking-micro text-mid">target</span>
          <Segmented<TargetKind>
            label="Target"
            value={draft.target}
            onChange={(v) => set("target", v)}
            options={[
              { value: "device", label: "Device" },
              { value: "room", label: "Room scene" },
            ]}
          />
        </div>

        {draft.target === "device" ? (
          <>
            <Field label="device" hint="omit to fire against the config default device">
              <SelectBox label="Target device" value={draft.device} onChange={(v) => set("device", v)}>
                <option value="">(default device)</option>
                {!deviceKnown ? <option value={draft.device}>{draft.device}</option> : null}
                {deviceOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name ?? d.ref}
                  </option>
                ))}
              </SelectBox>
            </Field>
            <Field
              label="command"
              error={errors.command}
              hint="same verbs as govee-cli power/brightness/color/temp/scene"
            >
              <Input
                type="text"
                value={draft.command}
                onChange={(e) => set("command", e.target.value)}
                placeholder="power on"
                spellCheck={false}
                autoComplete="off"
                className={cn(INPUT_CLASS, "font-mono pointer-coarse:h-11")}
              />
            </Field>
            <div className="-mt-2 flex flex-wrap gap-1.5 max-sm:grid max-sm:grid-cols-2">
              {QUICK_COMMANDS.map((cmd) => (
                <Pressable
                  key={cmd}
                  type="button"
                  aria-pressed={draft.command === cmd}
                  aria-label={`Use command ${cmd}`}
                  onClick={() => set("command", cmd)}
                  className={cn(
                    "cursor-pointer rounded-chip border px-2.5 py-1.5 font-mono text-micro uppercase leading-none tracking-caps transition-colors duration-motion-150 pointer-coarse:min-h-11",
                    draft.command === cmd
                      ? "border-hairline-strong bg-accent-dim text-hi"
                      : "border-hairline text-mid hover:border-hairline-strong hover:text-hi",
                  )}
                >
                  {cmd}
                </Pressable>
              ))}
            </div>
          </>
        ) : (
          <Field
            label="room scene"
            error={errors.room}
            hint={
              sceneInfo
                ? `${sceneInfo.device_count} ${sceneInfo.device_count === 1 ? "device" : "devices"} · ${sceneInfo.source}`
                : draft.roomScene
                  ? "this scene no longer exists, so the rule cannot fire"
                  : undefined
            }
          >
            <SelectBox label="Room scene" value={draft.roomScene} onChange={(v) => set("roomScene", v)}>
              <option value="">(choose a scene)</option>
              {draft.roomScene && !sceneInfo ? (
                <option value={draft.roomScene}>{draft.roomScene} (missing)</option>
              ) : null}
              {scenes.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </SelectBox>
          </Field>
        )}

        {errors.form ? (
          <p role="alert" className="flex items-start gap-1.5 font-mono text-data leading-snug text-ember">
            <TriangleAlert size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
            {errors.form}
          </p>
        ) : null}

        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          {rule ? (
            <Button
              type="button"
              variant={armed ? "danger" : "ghost"}
              busy={remove.isPending}
              onBlur={() => setArmed(false)}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                remove.mutate(rule.id);
              }}
              className={armed ? undefined : "text-ember"}
            >
              {armed ? "confirm delete?" : "delete rule"}
            </Button>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="solid" busy={save.isPending}>
              save
            </Button>
          </span>
        </div>
      </form>
    </>
  );
}

/**
 * One dialog for add AND edit. `rule` null = new. The form mounts only while
 * open, so each opening starts from the stored rule: an off-grid
 * `sunset-1h10m` is shown, and saved, exactly as stored.
 */
export function RuleDialog({
  open,
  onOpenChange,
  rule,
  now,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: ScheduleRule | null;
  now: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={rule ? (e) => e.preventDefault() : undefined}>
        <RuleForm rule={rule} now={now} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
