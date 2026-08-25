"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Plus } from "lucide-react";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Panel,
  SectionLabel,
  Skeleton,
  StatusDot,
} from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, type DeviceSummary } from "@/lib/api";
import { useDevices, useGroups } from "@/lib/queries";
import { panelIn } from "@/lib/motion";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import { Field, INPUT_CLASS } from "./field";
import { createGroup, deleteGroup } from "./sidecar";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/* ----------------------------------------------------- create dialog */

function CreateGroupDialog({
  open,
  onOpenChange,
  devices,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: DeviceSummary[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [members, setMembers] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<{ name?: string; members?: string; form?: string }>({});

  const create = useMutation({
    mutationFn: () => createGroup(name.trim(), [...members]),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({
        variant: "ok",
        title: "Group saved",
        description: `${result.name} · ${result.devices.length} ${result.devices.length === 1 ? "member" : "members"}`,
      });
      setName("");
      setMembers(new Set());
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors((prev) => ({ ...prev, form: err.message }));
      else toast({ variant: "error", title: "Create failed", description: String(err) });
    },
  });

  function toggleMember(id: string) {
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setErrors((prev) => ({ ...prev, members: undefined }));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!name.trim()) found.name = "give the group a name";
    if (members.size === 0) found.members = "pick at least one member";
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    create.mutate();
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
        <DialogTitle>create group</DialogTitle>
        <DialogDescription>
          a named set of devices — group controls broadcast to every member.
        </DialogDescription>

        <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
          <Field label="name" error={errors.name}>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((prev) => ({ ...prev, name: undefined, form: undefined }));
              }}
              placeholder="living-room"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="members" error={errors.members}>
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-btn border border-hairline bg-raised p-1.5">
              {devices.length === 0 ? (
                <p className="px-2 py-1.5 font-mono text-[11px] text-low">
                  no devices registered yet
                </p>
              ) : (
                devices.map((d) => (
                  // §11.3: the wrapping <label> is the real tap target (the
                  // checkbox itself stays a native 14px box, same "grow the
                  // hit area, not the ink" pattern as the device dock) — at
                  // px-2 py-1.5 the row measured well under 44px tall.
                  // `pointer-coarse:min-h-11` is a floor, so it only ever
                  // adds space inside this dialog's own scrollable member
                  // list, never moving anything else on the page.
                  <label
                    key={d.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-chip px-2 py-1.5 pointer-coarse:min-h-11 text-[13px] text-mid transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
                  >
                    <input
                      type="checkbox"
                      checked={members.has(d.id)}
                      onChange={() => toggleMember(d.id)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className="truncate">{d.name ?? d.ref}</span>
                    <span className="ml-auto font-mono text-[10px] text-low">{d.model}</span>
                  </label>
                ))
              )}
            </div>
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
            <Button type="submit" variant="solid" busy={create.isPending}>
              save group
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ section */

export function GroupsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const groups = useGroups();
  const devices = useDevices();
  const [createOpen, setCreateOpen] = React.useState(false);

  const remove = useMutation({
    mutationFn: (name: string) => deleteGroup(name),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["group-state"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ variant: "ok", title: "Group deleted", description: result.deleted });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Delete failed", description: errMessage(err) });
    },
  });

  const deviceList = React.useMemo(() => devices.data ?? [], [devices.data]);
  const nameOf = React.useCallback(
    (id: string) =>
      deviceList.find((d) => d.id === id || d.ref === id)?.name ?? id,
    [deviceList],
  );

  const entries = Object.entries(groups.data ?? {});

  return (
    <motion.section variants={panelIn}>
      <div className="flex items-center gap-3">
        <SectionLabel index={3} title="groups" />
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} strokeWidth={1.75} aria-hidden />
          create group
        </Button>
      </div>

      <Panel className="mt-3 p-5">
        {groups.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : entries.length === 0 && !groups.isError ? (
          <p className="py-1 font-mono text-[11px] leading-relaxed text-low">
            no groups — create one to batch-control a room
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {entries.map(([name, memberIds]) => (
              <li
                key={name}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <StatusDot
                  tone={
                    memberIds.some((id) =>
                      deviceList.some((d) => d.id === id && d.online !== false),
                    )
                      ? "ok"
                      : "off"
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium leading-tight text-hi">{name}</p>
                  {/* §11.2(6): the member list is the one thing this row
                      exists to say — which lights actually fire when the
                      group is triggered — and it was hover-only via
                      `title`. No fixed max-w on this element to lift; the
                      parent's `min-w-0 flex-1` already bounds it. */}
                  <p
                    className="mt-0.5 truncate font-mono text-[10px] text-low pointer-coarse:whitespace-normal pointer-coarse:break-words"
                    title={memberIds.map(nameOf).join(" · ")}
                  >
                    {memberIds.map(nameOf).join(" · ")}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-low">
                  {memberIds.length}
                </span>
                <ConfirmDeleteButton
                  label={`Delete group ${name}`}
                  onConfirm={() => remove.mutate(name)}
                />
              </li>
            ))}
          </ul>
        )}

        {groups.isError ? (
          <p className="mt-3 border-t border-hairline pt-3 font-mono text-[11px] text-ember">
            {errMessage(groups.error)}
          </p>
        ) : null}
      </Panel>

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        devices={deviceList}
      />
    </motion.section>
  );
}
