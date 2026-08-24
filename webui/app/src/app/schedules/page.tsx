"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Plus, Trash2 } from "lucide-react";

import { Button, Chip, Panel, SectionLabel, Skeleton, Switch } from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { StatusStrip } from "@/components/shell/status-strip";
import { TopBar } from "@/components/shell/top-bar";
import { ApiError, api, type DeviceSummary, type ScheduleRule } from "@/lib/api";
import { useDevices, useSchedules } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn, staggerParent } from "@/lib/motion";

import { AddRuleDialog } from "./add-rule-dialog";
import { formatNextFire, nextFireDateTime } from "./next-fire";

/* ==================================================================
   Schedules — rule list with enable toggles, add-rule sheet and
   next-fire hints. The embedded sidecar scheduler does the firing;
   this page only edits the rules.
   ================================================================== */

/** Ticking clock; null until mounted so SSR output stays stable. */
function useNow(intervalMs = 30_000): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/* ------------------------------------------------------- delete button */

/**
 * Two-step delete: trash click arms a danger "confirm?" state that
 * disarms itself after 3s (or on blur). One DOM node throughout, so
 * keyboard focus survives the morph. No window.confirm anywhere.
 */
function DeleteRuleButton({ onConfirm, label }: { onConfirm: () => void; label: string }) {
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);

  return (
    <Button
      size="sm"
      variant={armed ? "danger" : "ghost"}
      aria-label={armed ? `Confirm delete ${label}` : label}
      title={armed ? undefined : label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      className={cn("justify-center", armed ? "px-2.5" : "w-7 px-0")}
    >
      {armed ? (
        "confirm?"
      ) : (
        <Trash2 size={13} strokeWidth={1.5} aria-hidden />
      )}
    </Button>
  );
}

/* ------------------------------------------------------------------ row */

function RuleRow({ rule, devices }: { rule: ScheduleRule; devices: DeviceSummary[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const now = useNow();

  // Optimistic toggle: flip the cached rule immediately, roll back on refusal.
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setScheduleEnabled(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["schedules"] });
      const previous = queryClient.getQueryData<ScheduleRule[]>(["schedules"]);
      queryClient.setQueryData<ScheduleRule[]>(["schedules"], (old) =>
        old?.map((r) => (r.id === id ? { ...r, enabled } : r)),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["schedules"], context.previous);
      toast({
        variant: "error",
        title: "Could not update rule",
        description: errMessage(err),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["schedules"] });
      const previous = queryClient.getQueryData<ScheduleRule[]>(["schedules"]);
      queryClient.setQueryData<ScheduleRule[]>(["schedules"], (old) =>
        old?.filter((r) => r.id !== id),
      );
      return { previous };
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(["schedules"], context.previous);
      toast({ variant: "error", title: "Delete failed", description: errMessage(err) });
    },
    onSuccess: () => {
      toast({ variant: "ok", title: "Rule deleted", description: rule.name });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });

  const targetName = rule.device
    ? (devices.find((d) => d.id === rule.device || d.ref === rule.device)?.name ?? rule.device)
    : "default device";

  const nextLabel = !rule.enabled
    ? "paused"
    : now
      ? formatNextFire(nextFireDateTime(rule.time, rule.days, now))
      : "—";

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0",
        !rule.enabled && "opacity-55",
      )}
    >
      <Switch
        checked={rule.enabled}
        onCheckedChange={(enabled) => setEnabled.mutate({ id: rule.id, enabled })}
        ariaLabel={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
      />

      <div className="min-w-[120px] max-w-full">
        <p className="truncate text-[13px] font-medium leading-tight text-hi">{rule.name}</p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-low">{targetName}</p>
      </div>

      <span className="font-mono text-[12px] tabular-nums text-mid">{rule.time}</span>

      <span className="flex flex-wrap gap-1">
        {rule.days.map((day) => (
          <Chip key={day}>{day}</Chip>
        ))}
      </span>

      <span className="max-w-[220px] truncate font-mono text-[11px] text-mid" title={rule.command}>
        {rule.command}
      </span>

      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-low" title="next fire">
        {nextLabel}
      </span>

      <DeleteRuleButton
        label={`Delete rule ${rule.name}`}
        onConfirm={() => remove.mutate(rule.id)}
      />
    </li>
  );
}

/* ------------------------------------------------------------------ page */

export default function SchedulesPage() {
  const schedules = useSchedules();
  const devices = useDevices();
  const [addOpen, setAddOpen] = React.useState(false);

  const rules = schedules.data ?? [];
  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <TopBar crumbs={["schedules"]} />

      <div className="flex min-h-0 flex-1">
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
                  Schedules
                </h1>
                <p className="mt-1 font-mono text-[11px] text-low">
                  {schedules.isLoading
                    ? "loading rules…"
                    : `${rules.length} ${rules.length === 1 ? "rule" : "rules"} · ${enabledCount} enabled`}
                </p>
              </div>
              <Button variant="solid" onClick={() => setAddOpen(true)}>
                <Plus size={14} strokeWidth={1.75} aria-hidden />
                new rule
              </Button>
            </motion.section>

            {/* error state */}
            {schedules.isError ? (
              <motion.section variants={panelIn}>
                <Panel className="border-ember/40 p-5">
                  <p className="text-[13px] font-medium text-hi">Rules unavailable</p>
                  <p className="mt-1 font-mono text-[11px] text-mid">
                    {errMessage(schedules.error)} — is the sidecar running on 127.0.0.1:6057?
                  </p>
                </Panel>
              </motion.section>
            ) : null}

            {/* rule list */}
            <motion.section variants={panelIn}>
              <SectionLabel index={1} title="rules" />
              <Panel className="mt-3 p-5">
                {schedules.isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i} className="flex items-center gap-3 py-1">
                        <Skeleton className="h-6 w-11 rounded-full" />
                        <Skeleton className="h-5 w-36" />
                        <Skeleton className="h-5 w-14" />
                        <Skeleton className="ml-auto h-5 w-20" />
                      </div>
                    ))}
                  </div>
                ) : rules.length === 0 && !schedules.isError ? (
                  <p className="py-2 font-mono text-[11px] leading-relaxed text-low">
                    no rules yet — press{" "}
                    <span className="text-mid">new rule</span> above to schedule your first command
                  </p>
                ) : (
                  <ul className="divide-y divide-hairline">
                    {rules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} devices={devices.data ?? []} />
                    ))}
                  </ul>
                )}
              </Panel>
            </motion.section>
          </motion.div>
        </main>
      </div>

      <StatusStrip />

      <AddRuleDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
