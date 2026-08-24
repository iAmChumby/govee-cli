"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ChevronDown, Plus, RadioTower } from "lucide-react";

import { Button, Chip, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Panel, SectionLabel, Skeleton, StatusDot } from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, api } from "@/lib/api";
import { useDevices } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn } from "@/lib/motion";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import { Field, INPUT_CLASS } from "./field";
import { deleteDevice, registerDevice, type RegisterDeviceBody } from "./sidecar";

/** The four models this deployment supports (WEBUI_SPEC §3). */
const SUPPORTED_MODELS = ["H6056", "H6008", "H6183", "H6022"] as const;

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/* -------------------------------------------------------- add dialog */

interface AddDeviceDraft {
  mac: string;
  model: string;
  name: string;
  staticMac: string;
}

type AddDeviceErrors = Partial<Record<"mac" | "model" | "form", string>>;

const EMPTY_DRAFT: AddDeviceDraft = { mac: "", model: "H6056", name: "", staticMac: "" };

function AddDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<AddDeviceDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = React.useState<AddDeviceErrors>({});

  const register = useMutation({
    mutationFn: (body: RegisterDeviceBody) => registerDevice(body),
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({
        variant: "ok",
        title: "Device registered",
        description: `${entry.name ?? entry.mac} · ${entry.model}`,
      });
      setDraft(EMPTY_DRAFT);
      onOpenChange(false);
    },
    onError: (err) => {
      // surface the sidecar's validation wording at the form level
      if (err instanceof ApiError) setErrors((prev) => ({ ...prev, form: err.message }));
      else toast({ variant: "error", title: "Register failed", description: String(err) });
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found: AddDeviceErrors = {};
    if (!draft.mac.trim()) found.mac = "the 8-octet cloud device id is required";
    if (!SUPPORTED_MODELS.includes(draft.model as (typeof SUPPORTED_MODELS)[number])) {
      found.model = "pick a supported model";
    }
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    const body: RegisterDeviceBody = {
      mac: draft.mac.trim(),
      model: draft.model,
    };
    if (draft.name.trim()) body.name = draft.name.trim();
    if (draft.staticMac.trim()) body.static_mac = draft.staticMac.trim();
    register.mutate(body);
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
        <DialogTitle>add device</DialogTitle>
        <DialogDescription>
          registers an entry in the config registry — same validations as govee-cli config.
        </DialogDescription>

        <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
          <Field label="device id" error={errors.mac} hint="8-octet cloud id, e.g. 50:CE:E8:6E:80:C6:50:3F">
            <input
              type="text"
              value={draft.mac}
              onChange={(e) => {
                setDraft((prev) => ({ ...prev, mac: e.target.value }));
                setErrors((prev) => ({ ...prev, mac: undefined, form: undefined }));
              }}
              placeholder="AA:BB:CC:DD:EE:FF:00:11"
              spellCheck={false}
              autoComplete="off"
              className={cn(INPUT_CLASS, "font-mono text-[12px]")}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="model" error={errors.model}>
              <span className="relative block">
                <select
                  value={draft.model}
                  onChange={(e) => setDraft((prev) => ({ ...prev, model: e.target.value }))}
                  className={cn(INPUT_CLASS, "cursor-pointer appearance-none pr-8 font-mono text-[12px]")}
                >
                  {SUPPORTED_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model}
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

            <Field label="name" hint="optional friendly name">
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Shelf Lamp"
                autoComplete="off"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <Field label="static mac" hint="optional BLE address, e.g. E8:6E:80:C6:50:3F">
            <input
              type="text"
              value={draft.staticMac}
              onChange={(e) => setDraft((prev) => ({ ...prev, staticMac: e.target.value }))}
              placeholder="AA:BB:CC:DD:EE:FF"
              spellCheck={false}
              autoComplete="off"
              className={cn(INPUT_CLASS, "font-mono text-[12px]")}
            />
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
            <Button type="submit" variant="solid" busy={register.isPending}>
              register
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- section */

export function DevicesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const devices = useDevices();
  const [addOpen, setAddOpen] = React.useState(false);

  const scan = useMutation({
    mutationFn: () => api.discover(),
    onSuccess: (found) => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      const count = found.devices.length;
      toast({
        variant: "ok",
        title: "Cloud scan finished",
        description: `${count} ${count === 1 ? "device" : "devices"} visible`,
      });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Cloud scan failed", description: errMessage(err) });
    },
  });

  const remove = useMutation({
    mutationFn: (mac: string) => deleteDevice(mac),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({
        variant: "ok",
        title: "Device removed",
        description: result.cleared_default
          ? `${result.removed} · default pointer cleared`
          : result.removed,
      });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Remove failed", description: errMessage(err) });
    },
  });

  const list = devices.data ?? [];

  return (
    <motion.section variants={panelIn}>
      <div className="flex items-center gap-3">
        <SectionLabel index={2} title="devices" />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={13} strokeWidth={1.75} aria-hidden />
          add device
        </Button>
        <Button size="sm" busy={scan.isPending} onClick={() => scan.mutate()}>
          <RadioTower size={13} strokeWidth={1.75} aria-hidden />
          scan cloud
        </Button>
      </div>

      <Panel className="mt-3 p-5">
        {devices.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : list.length === 0 && !devices.isError ? (
          <p className="py-1 font-mono text-[11px] leading-relaxed text-low">
            no devices registered — scan the cloud or add one manually
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {list.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="flex min-w-0 items-center gap-2.5 sm:w-44">
                  <StatusDot tone={d.online === false ? "off" : "ok"} />
                  <span className="truncate text-[13px] font-medium text-hi">
                    {d.name ?? d.ref}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1.5">
                  {d.model ? <Chip>{d.model}</Chip> : null}
                  <Chip>{d.transport}</Chip>
                </span>

                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-low"
                  title={d.id}
                >
                  {d.id}
                </span>

                <ConfirmDeleteButton
                  label={`Remove ${d.name ?? d.id}`}
                  onConfirm={() => remove.mutate(d.id)}
                />
              </li>
            ))}
          </ul>
        )}

        {devices.isError ? (
          <p className="mt-3 border-t border-hairline pt-3 font-mono text-[11px] text-ember">
            {errMessage(devices.error)}
          </p>
        ) : null}
      </Panel>

      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} />
    </motion.section>
  );
}
