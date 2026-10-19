"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";

import { Button, Panel, SectionLabel, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/toaster";
import { ApiError, type ScheduleList, type ScheduleLocation } from "@/lib/api";
import { useSchedules } from "@/lib/queries";
import { panelIn } from "@/lib/motion";
import { formatZone } from "@/lib/schedule-format";

import { Field, INPUT_CLASS } from "./field";
import { patchConfig, type ConfigPatchBody } from "./sidecar";

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

interface LocationForm {
  lat: string;
  lon: string;
  tz: string;
}

type LocationErrors = Partial<Record<"lat" | "lon" | "form", string>>;

/** The effective location seeds the form. Host-default zones leave the field blank. */
function seedFrom(loc: ScheduleLocation | undefined): LocationForm {
  if (!loc) return { lat: "", lon: "", tz: "" };
  return {
    lat: loc.latitude == null ? "" : String(loc.latitude),
    lon: loc.longitude == null ? "" : String(loc.longitude),
    tz: loc.timezone_source === "config" ? loc.timezone : "",
  };
}

/** Blank is "unset"; anything else must be a finite number inside the range. */
function inRange(raw: string, min: number, max: number): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= min && n <= max;
}

function validate(form: LocationForm): LocationErrors {
  const found: LocationErrors = {};
  const latBlank = form.lat.trim() === "";
  const lonBlank = form.lon.trim() === "";

  if (latBlank && lonBlank) {
    found.form = "enter both coordinates to save, or use clear to remove the location";
    return found;
  }
  if (latBlank) found.lat = "needed with longitude";
  else if (!inRange(form.lat, -90, 90)) found.lat = "a number from -90 to 90";

  if (lonBlank) found.lon = "needed with latitude";
  else if (!inRange(form.lon, -180, 180)) found.lon = "a number from -180 to 180";

  return found;
}

/**
 * Location for sun-relative schedule times. Sunrise and sunset need a
 * latitude and longitude; without them a sun rule has no next run, and the
 * caption says so. Values seed from the schedule list's effective location,
 * so the zone label matches what the scheduler actually uses.
 */
export function LocationSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const schedules = useSchedules();
  const location = schedules.data?.location;

  const [form, setForm] = React.useState<LocationForm>({ lat: "", lon: "", tz: "" });
  const [errors, setErrors] = React.useState<LocationErrors>({});

  // Re-seed when the effective location changes (after a save or clear).
  React.useEffect(() => {
    setForm(seedFrom(location));
  }, [location]);

  const hasLocation = location?.latitude != null || location?.longitude != null;

  /**
   * A 200 from PATCH is not proof the location was stored. Refetch the
   * schedule list and check the effective location the scheduler reports.
   */
  async function storedAs(matches: (loc: ScheduleLocation) => boolean): Promise<boolean> {
    await queryClient.invalidateQueries({ queryKey: ["config"] });
    await queryClient.invalidateQueries({ queryKey: ["schedules"] });
    const loc = queryClient.getQueryData<ScheduleList>(["schedules"])?.location;
    return loc !== undefined && matches(loc);
  }

  const save = useMutation({
    mutationFn: (values: LocationForm) => {
      const body: ConfigPatchBody = {
        latitude: Number(values.lat.trim()),
        longitude: Number(values.lon.trim()),
      };
      if (values.tz.trim()) body.timezone = values.tz.trim();
      return patchConfig(body);
    },
    onSuccess: async (_data, values) => {
      const lat = Number(values.lat.trim());
      const lon = Number(values.lon.trim());
      const stored = await storedAs((loc) => loc.latitude === lat && loc.longitude === lon);
      if (stored) {
        setErrors({});
        toast({ variant: "ok", title: "Location saved", description: "sun-relative rules recomputed" });
      } else {
        setErrors({
          form: "the sidecar accepted the request but its schedule location did not change; check the sidecar log",
        });
      }
    },
    onError: (err) => {
      setErrors({ form: errMessage(err) });
    },
  });

  const clear = useMutation({
    mutationFn: () => patchConfig({ clear_location: true }),
    onSuccess: async () => {
      const cleared = await storedAs((loc) => loc.latitude === null && loc.longitude === null);
      if (cleared) {
        setErrors({});
        toast({ variant: "ok", title: "Location cleared", description: "sun-relative rules have no next run" });
      } else {
        setErrors({
          form: "the sidecar accepted the request but still reports a location; check the sidecar log",
        });
      }
    },
    onError: (err) => {
      setErrors({ form: errMessage(err) });
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    save.mutate(form);
  }

  return (
    <motion.section variants={panelIn}>
      <SectionLabel index={5} title="location" />
      <Panel className="mt-3 p-5">
        {schedules.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <p className="font-mono text-[11px] leading-relaxed text-mid">
              Sun-relative schedule times (sunset-1h) are computed from this location. Without it, those rules do not run.
            </p>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="latitude" error={errors.lat} hint="decimal degrees, north positive">
                <input
                  type="number"
                  value={form.lat}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, lat: e.target.value }));
                    setErrors((prev) => ({ ...prev, lat: undefined, form: undefined }));
                  }}
                  min={-90}
                  max={90}
                  step="any"
                  inputMode="decimal"
                  placeholder="51.5074"
                  className={INPUT_CLASS + " font-mono text-[12px] tabular-nums"}
                />
              </Field>

              <Field label="longitude" error={errors.lon} hint="decimal degrees, east positive">
                <input
                  type="number"
                  value={form.lon}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, lon: e.target.value }));
                    setErrors((prev) => ({ ...prev, lon: undefined, form: undefined }));
                  }}
                  min={-180}
                  max={180}
                  step="any"
                  inputMode="decimal"
                  placeholder="-0.1278"
                  className={INPUT_CLASS + " font-mono text-[12px] tabular-nums"}
                />
              </Field>

              <Field
                label="timezone"
                hint={location ? `using ${formatZone(location)}` : undefined}
              >
                <input
                  type="text"
                  value={form.tz}
                  onChange={(e) => setForm((prev) => ({ ...prev, tz: e.target.value }))}
                  placeholder="blank = host zone"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT_CLASS + " font-mono text-[12px]"}
                />
              </Field>
            </div>

            {errors.form ? (
              <p role="alert" className="font-mono text-[11px] leading-relaxed text-ember">
                {errors.form}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-4">
              <Button
                type="button"
                variant="ghost"
                busy={clear.isPending}
                disabled={!hasLocation || save.isPending}
                onClick={() => {
                  setErrors({});
                  clear.mutate();
                }}
              >
                clear location
              </Button>
              <Button type="submit" variant="solid" busy={save.isPending} disabled={clear.isPending}>
                save location
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </motion.section>
  );
}
