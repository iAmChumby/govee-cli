"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ChevronDown } from "lucide-react";

import { Button, Panel, SectionLabel, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, type DeviceSummary } from "@/lib/api";
import { useDevices } from "@/lib/queries";
import { cn } from "@/lib/cn";
import { panelIn } from "@/lib/motion";

import { Field, INPUT_CLASS } from "./field";
import { patchConfig, useConfig, type ConfigPatchBody } from "./sidecar";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

interface DefaultsForm {
  mac: string;
  timeout: string;
  brightness: string;
  color: string;
}

type DefaultsErrors = Partial<Record<"timeout" | "brightness" | "color" | "form", string>>;

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

/**
 * Config defaults editor. Values seed from GET /config once; blank
 * fields are omitted from the PATCH so they stay unchanged.
 */
export function DefaultsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const config = useConfig();
  const devices = useDevices();

  const [form, setForm] = React.useState<DefaultsForm>({
    mac: "",
    timeout: "",
    brightness: "",
    color: "",
  });
  const [errors, setErrors] = React.useState<DefaultsErrors>({});

  // Seed the form when the config arrives (or is refetched after a save).
  React.useEffect(() => {
    const data = config.data;
    if (!data) return;
    setForm({
      mac: data.default_mac ?? "",
      timeout: String(data.default_timeout ?? ""),
      brightness: data.default_brightness == null ? "" : String(data.default_brightness),
      color: data.default_color ? `#${data.default_color.replace(/^#/, "")}` : "",
    });
  }, [config.data]);

  const deviceList: DeviceSummary[] = devices.data ?? [];

  const save = useMutation({
    mutationFn: () => {
      const body: ConfigPatchBody = {};
      if (form.mac) body.default_mac = form.mac;
      if (form.timeout !== "") body.default_timeout = Number(form.timeout);
      if (form.brightness !== "") body.default_brightness = Number(form.brightness);
      if (form.color.trim()) body.default_color = form.color.trim().replace(/^#/, "");
      return patchConfig(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ variant: "ok", title: "Defaults saved", description: "written to the govee-cli config" });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Save failed", description: errMessage(err) });
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found: DefaultsErrors = {};
    if (form.timeout !== "") {
      const n = Number(form.timeout);
      if (!Number.isFinite(n) || n <= 0) found.timeout = "must be a positive number";
    }
    if (form.brightness !== "") {
      const n = Number(form.brightness);
      if (!Number.isInteger(n) || n < 0 || n > 100) found.brightness = "integer between 0 and 100";
    }
    if (form.color.trim() && !HEX_PATTERN.test(form.color.trim())) {
      found.color = "hex like #FF8800";
    }
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    save.mutate();
  }

  return (
    <motion.section variants={panelIn}>
      <SectionLabel index={4} title="defaults" />
      <Panel className="mt-3 p-5">
        {config.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="default device" hint="used when a command names no device">
                <span className="relative block">
                  <select
                    value={form.mac}
                    onChange={(e) => setForm((prev) => ({ ...prev, mac: e.target.value }))}
                    className={cn(INPUT_CLASS, "cursor-pointer appearance-none pr-8 font-mono text-[12px]")}
                  >
                    <option value="">— none —</option>
                    {deviceList.map((d) => (
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

              <Field label="default timeout" error={errors.timeout} hint="seconds per cloud call">
                <input
                  type="number"
                  value={form.timeout}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, timeout: e.target.value }));
                    setErrors((prev) => ({ ...prev, timeout: undefined }));
                  }}
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  className={cn(INPUT_CLASS, "font-mono text-[12px] tabular-nums")}
                />
              </Field>

              <Field label="default brightness" error={errors.brightness} hint="percent, 0–100">
                <input
                  type="number"
                  value={form.brightness}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, brightness: e.target.value }));
                    setErrors((prev) => ({ ...prev, brightness: undefined }));
                  }}
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  className={cn(INPUT_CLASS, "font-mono text-[12px] tabular-nums")}
                />
              </Field>

              <Field label="default color" error={errors.color} hint="hex like #FF8800">
                <input
                  type="text"
                  value={form.color}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, color: e.target.value }));
                    setErrors((prev) => ({ ...prev, color: undefined }));
                  }}
                  placeholder="#FF8800"
                  spellCheck={false}
                  maxLength={7}
                  autoComplete="off"
                  className={cn(INPUT_CLASS, "font-mono text-[12px] uppercase")}
                />
              </Field>
            </div>

            {errors.form ? (
              <p role="alert" className="font-mono text-[11px] leading-snug text-ember">
                {errors.form}
              </p>
            ) : null}

            <div className="flex items-center justify-end border-t border-hairline pt-4">
              <Button
                type="submit"
                variant="solid"
                busy={save.isPending}
                disabled={!config.data}
              >
                save defaults
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </motion.section>
  );
}
