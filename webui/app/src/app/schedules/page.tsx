"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Pencil, Plus, TriangleAlert } from "lucide-react";

import { Button, Panel, SectionLabel, Skeleton, Switch } from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, api, type DeviceSummary, type ScheduleList, type ScheduleRule } from "@/lib/api";
import { useDevices, useExternalSchedules, useSchedules } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn, staggerParent } from "@/lib/motion";
import { formatNextRun, wallHM } from "@/lib/schedule-format";

import { ExternalAutomationPanel } from "./external-panel";
import { OwnerStrip } from "./owner-strip";
import { DAYS, RuleDialog } from "./rule-dialog";
import { ScheduleTimeline } from "./timeline";

/* ==================================================================
   Schedules: owner strip, today's timeline, rule list. Rules are added
   and edited in one dialog; next-run times come from the server.
   ================================================================== */

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function targetLine(rule: ScheduleRule, devices: DeviceSummary[]): string {
  if (rule.room_scene) return `room scene ${rule.room_scene}`;
  const name = rule.device
    ? (devices.find((d) => d.id === rule.device || d.ref === rule.device)?.name ?? rule.device)
    : "default device";
  return `${name} · ${rule.command}`;
}

/* ------------------------------------------------------------------ row */

function RuleRow({
  rule,
  list,
  devices,
  highlighted,
  onEdit,
}: {
  rule: ScheduleRule;
  list: ScheduleList;
  devices: DeviceSummary[];
  highlighted?: boolean;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Optimistic toggle: flip the cached rule immediately, roll back on refusal.
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setScheduleEnabled(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["schedules"] });
      const previous = queryClient.getQueryData<ScheduleList>(["schedules"]);
      queryClient.setQueryData<ScheduleList>(["schedules"], (old) =>
        old
          ? { ...old, schedules: old.schedules.map((r) => (r.id === id ? { ...r, enabled } : r)) }
          : old,
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["schedules"], context.previous);
      toast({ variant: "error", title: "Could not update rule", description: errMessage(err) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });

  const next = formatNextRun(rule.next_run, rule.next_run_reason, list.now);
  const lastError = rule.last_result === "error";

  return (
    <li
      id={`rule-${rule.id}`}
      className={cn(
        "-mx-2 rounded-card px-2 py-3 transition-colors duration-motion-500 first:pt-0 last:pb-0",
        highlighted && "bg-accent-dim",
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(enabled) => setEnabled.mutate({ id: rule.id, enabled })}
          ariaLabel={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
        />

        <div className={cn("min-w-0", !rule.enabled && "opacity-55")}>
          <p className="break-words text-body font-medium leading-tight text-hi">{rule.name}</p>
          <p className="mt-0.5 break-words font-mono text-data leading-snug text-mid">
            {targetLine(rule, devices)}
          </p>
        </div>

        {/* The hit area grows on coarse pointers; the bordered ink stays 28px. */}
        <button
          type="button"
          aria-label={`Edit rule ${rule.name}`}
          onClick={onEdit}
          className="group inline-flex h-7 w-7 cursor-pointer items-center justify-center pointer-coarse:-m-2 pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-btn border border-hairline text-mid transition-colors duration-motion-150 group-hover:border-hairline-strong group-hover:bg-accent-dim group-hover:text-hi">
            <Pencil size={13} strokeWidth={1.5} aria-hidden />
          </span>
        </button>

        <div className={cn("col-span-3 space-y-1.5", !rule.enabled && "opacity-55")}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="font-mono text-data tabular-nums text-hi">{rule.time}</span>
            <span className="flex gap-1" role="group" aria-label="Days">
              {DAYS.map((day) => {
                const on = rule.days.includes(day);
                return (
                  <span
                    key={day}
                    aria-label={`${day} ${on ? "on" : "off"}`}
                    className={cn(
                      "rounded-chip border px-1.5 py-space-3 font-mono text-micro uppercase leading-none tracking-data",
                      on
                        ? "border-hairline-strong bg-accent-dim text-hi"
                        : "border-transparent text-low opacity-40",
                    )}
                  >
                    {day}
                  </span>
                );
              })}
            </span>
          </div>

          <p data-volatile="true" className="font-mono text-data tabular-nums text-mid">
            next: {next}
          </p>
        </div>

        {rule.target_problem || rule.missed_minute || lastError ? (
          <div className="col-span-3 space-y-1 font-mono text-data leading-snug">
            {rule.target_problem ? (
              <p className="flex items-start gap-1.5 text-ember">
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
                {rule.target_problem}
              </p>
            ) : null}
            {rule.missed_minute ? (
              <p className="text-mid">missed {wallHM(rule.missed_minute)}</p>
            ) : null}
            {lastError ? (
              <p className="text-mid">
                last: error{rule.last_detail ? ` ${rule.last_detail}` : ""}
                {rule.last_at ? ` · ${wallHM(rule.last_at)}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ page */

export default function SchedulesPage() {
  const schedules = useSchedules();
  const devices = useDevices();
  const external = useExternalSchedules();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScheduleRule | null>(null);
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  const list = schedules.data;
  const rules = React.useMemo(() => list?.schedules ?? [], [list]);
  const enabledCount = rules.filter((r) => r.enabled).length;

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: ScheduleRule) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  // Timeline dots scroll to and briefly highlight the matching row.
  const handleSelectRule = React.useCallback((ruleId: string) => {
    setHighlightId(ruleId);
    document
      .getElementById(`rule-${ruleId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightId((cur) => (cur === ruleId ? null : cur)), 1600);
  }, []);

  return (
    <>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <motion.div
          variants={staggerParent}
          initial="hidden"
          animate="show"
          className="mx-auto max-w-space-1080 space-y-5 px-6 pb-16 pt-6"
        >
          {/* head */}
          <motion.section variants={panelIn} className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold leading-tight tracking-display text-hi">
                Schedules
              </h1>
              <p className="mt-1 font-mono text-data text-low">
                {schedules.isLoading
                  ? "loading rules…"
                  : `${rules.length} ${rules.length === 1 ? "rule" : "rules"} · ${enabledCount} enabled`}
              </p>
            </div>
            <Button variant="solid" onClick={openNew}>
              <Plus size={14} strokeWidth={1.75} aria-hidden />
              new rule
            </Button>
          </motion.section>

          {/* error state */}
          {schedules.isError ? (
            <motion.section variants={panelIn}>
              <Panel className="border-ember/40 p-5">
                <p className="text-body font-medium text-hi">Rules unavailable</p>
                <p className="mt-1 font-mono text-data text-mid">
                  {errMessage(schedules.error)} — is the sidecar running on 127.0.0.1:6057?
                </p>
              </Panel>
            </motion.section>
          ) : null}

          {/* who owns the schedule */}
          {list ? (
            <motion.section variants={panelIn}>
              <OwnerStrip list={list} />
            </motion.section>
          ) : null}

          {/* 24h timeline: native rules + external automation */}
          <motion.section variants={panelIn}>
            <SectionLabel index={1} title="today" />
            <Panel className="mt-3 p-5">
              <ScheduleTimeline
                rules={rules}
                nowIso={list?.now ?? null}
                external={external.data}
                externalLoading={external.isLoading}
                devices={devices.data ?? []}
                onSelectRule={handleSelectRule}
              />
            </Panel>
          </motion.section>

          {/* rule list */}
          <motion.section variants={panelIn}>
            <SectionLabel index={2} title="native rules" />
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
                <p className="py-2 font-mono text-label leading-relaxed text-low">
                  no rules yet — press <span className="text-mid">new rule</span> above to schedule
                  your first command
                </p>
              ) : list ? (
                <ul className="divide-y divide-hairline">
                  {rules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      list={list}
                      devices={devices.data ?? []}
                      highlighted={highlightId === rule.id}
                      onEdit={() => openEdit(rule)}
                    />
                  ))}
                </ul>
              ) : null}
            </Panel>
          </motion.section>

          {/* external automation: crontab-discovered, read-only */}
          <ExternalAutomationPanel />
        </motion.div>
      </main>

      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        now={list?.now ?? ""}
      />
    </>
  );
}
