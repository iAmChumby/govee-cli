"use client";

/**
 * React Query bindings over the sidecar API.
 *
 * State polls at 10s (the cloud tolerates ~2 req/s; the sidecar's TTL cache
 * absorbs bursts). Control mutations are optimistic where the result is
 * predictable — power, brightness, color, temperature — and roll back with an
 * error toast when the device or cloud refuses. Scene/DIY/music/toggle
 * mutations invalidate instead: the device reports "" for those, so there is
 * nothing meaningful to preview optimistically.
 *
 * Sync discipline: every state read passes through the intent ledger
 * (`reconcile`) so a lagging cloud read can never visibly undo a command, and
 * writes to one device are serialized through a per-ref promise chain so five
 * quick toggles land in order instead of racing.
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import {
  api,
  ApiError,
  type DeviceState,
  type DeviceSummary,
  type EffectCreateRequest,
  type ExternalSchedule,
  type SegmentCalibrationRequest,
} from "@/lib/api";
import {
  isPending,
  recordIntent,
  reconcile,
  subscribeIntents,
  type IntentPatch,
} from "@/lib/intent";
import { useToast } from "@/components/ui/toaster";

export const POLL_MS = 10_000;

function errMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/** Invalidate everything derived from a device's state. */
function deviceKeys(ref: string): QueryKey[] {
  return [
    ["devices"],
    ["device", ref],
    ["group-state"],
  ];
}

/* --------------------------------------------------------- write ordering */

/**
 * One in-flight write per device, in command order. The cloud processes
 * concurrent writes to the same lamp out of order; serializing keeps five
 * quick toggles deterministic and halves the burst rate as a bonus.
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(ref: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(ref) ?? Promise.resolve();
  // Run regardless of whether the previous write resolved or rejected.
  const next = previous.then(task, task);
  writeChains.set(ref, next.catch(() => undefined));
  return next;
}

/* ---------------------------------------------------------------- queries */

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const devices = await api.devices();
      return devices.map((d) => reconcile(d.ref, d));
    },
    refetchInterval: POLL_MS,
  });
}

export function useDeviceState(ref: string | null) {
  return useQuery({
    queryKey: ["device", ref],
    queryFn: async () => reconcile(ref as string, await api.deviceState(ref as string)),
    enabled: ref !== null,
    refetchInterval: POLL_MS,
  });
}

export function useScenes(ref: string | null) {
  return useQuery({
    queryKey: ["scenes", ref],
    queryFn: () => api.scenes(ref as string),
    enabled: ref !== null,
    staleTime: 5 * 60_000,
  });
}
export function useDiyScenes(ref: string | null) {
  return useQuery({
    queryKey: ["diy", ref],
    queryFn: () => api.diyScenes(ref as string),
    enabled: ref !== null,
    staleTime: 60_000,
  });
}

export function useSnapshots(ref: string | null) {
  return useQuery({
    queryKey: ["snapshots", ref],
    queryFn: () => api.snapshots(ref as string),
    enabled: ref !== null,
    staleTime: 60_000,
  });
}

export function useMusicModes(ref: string | null) {
  return useQuery({
    queryKey: ["music", ref],
    queryFn: () => api.musicModes(ref as string),
    enabled: ref !== null,
    staleTime: 5 * 60_000,
  });
}

export function useToggles(ref: string | null) {
  return useQuery({
    queryKey: ["toggles", ref],
    queryFn: () => api.toggles(ref as string),
    enabled: ref !== null,
    staleTime: 60_000,
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ["groups"],
    queryFn: api.groups,
    refetchInterval: POLL_MS,
  });
}

export function useGroupState(name: string | null) {
  return useQuery({
    queryKey: ["group-state", name],
    queryFn: async () => {
      const state = await api.groupState(name as string);
      return {
        ...state,
        devices: state.devices.map((d) => reconcile(d.ref, d)),
      };
    },
    enabled: name !== null,
    refetchInterval: POLL_MS,
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
  });
}

export function useEffects() {
  return useQuery({
    queryKey: ["effects"],
    queryFn: api.effects,
    staleTime: 5 * 60_000,
  });
}

export function usePlayingEffects() {
  return useQuery({
    queryKey: ["effects-playing"],
    queryFn: api.playingEffects,
    refetchInterval: 3_000,
  });
}

/* --------------------------------------------------------- pending state */

/** Reactive view of a device's unconfirmed commands — drives syncing pulses. */
export function usePendingState(ref: string | null): boolean {
  const subscribe = React.useCallback(
    (listener: () => void) => (ref ? subscribeIntents(listener) : () => undefined),
    [ref],
  );
  const snapshot = React.useCallback(
    () => (ref ? isPending(ref) : false),
    [ref],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/* ------------------------------------------------------------- mutations */

interface MutationMeta {
  /** short label for toasts, e.g. "Light Bars · power" */
  label: string;
}

function useOptimisticDeviceMutation<TVars>(
  meta: MutationMeta,
  mutationFn: (ref: string, vars: TVars) => Promise<DeviceState>,
  applyOptimistic: (
    previous: DeviceState | undefined,
    vars: TVars,
  ) => DeviceState | undefined,
  successTitle: (vars: TVars) => string,
  intent: (vars: TVars) => IntentPatch,
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ ref, vars }: { ref: string; vars: TVars }) =>
      enqueueWrite(ref, () => mutationFn(ref, vars)),
    onMutate: async ({ ref, vars }) => {
      // Ledger first: every read from now on holds the commanded value until
      // the cloud confirms it, however fast the user keeps toggling.
      recordIntent(ref, intent(vars));
      await queryClient.cancelQueries({ queryKey: ["device", ref] });
      const key: QueryKey = ["device", ref];
      const previous = queryClient.getQueryData<DeviceState>(key);
      const optimistic = applyOptimistic(previous, vars);
      if (optimistic) queryClient.setQueryData(key, optimistic);
      // Device plates read from the list cache too.
      queryClient.setQueryData<DeviceSummary[]>(["devices"], (old) =>
        old?.map((d) =>
          d.ref === ref && optimistic
            ? {
                ...d,
                power: optimistic.power,
                brightness: optimistic.brightness,
                color: optimistic.color,
                color_temp_k: optimistic.color_temp_k,
              }
            : d,
        ),
      );
      return { previous, key };
    },
    onError: (err, { ref }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.key, context.previous);
      }
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["device", ref] });
      toast({
        variant: "error",
        title: `${meta.label} failed`,
        description: errMessage(err),
      });
    },
    onSuccess: (state, { ref, vars }) => {
      // The sidecar echoes commanded values over lagging cloud reads, so this
      // state is intent-aware; reconcile confirms the ledger entry.
      queryClient.setQueryData(["device", ref], reconcile(ref, state));
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      toast({
        variant: "ok",
        title: successTitle(vars),
        description: `${state.name ?? ref} · ${state.transport}`,
      });
    },
  }).mutateAsync;
}

/**
 * Returns stable mutate helpers. Each takes {ref, ...vars}; each is
 * optimistic, intent-recorded, and self-toasting.
 */
export function useDeviceControls() {
  const power = useOptimisticDeviceMutation<boolean>(
    { label: "power" },
    (ref, on) => api.setPower(ref, on),
    (prev, on) => (prev ? { ...prev, power: on } : prev),
    (on) => (on ? "Powered on" : "Powered off"),
    (on) => ({ power: on }),
  );

  const brightness = useOptimisticDeviceMutation<number>(
    { label: "brightness" },
    (ref, value) => api.setBrightness(ref, value),
    (prev, value) => (prev ? { ...prev, brightness: value } : prev),
    (value) => `Brightness ${value}%`,
    (value) => ({ brightness: value }),
  );

  const color = useOptimisticDeviceMutation<string>(
    { label: "color" },
    (ref, hex) => api.setColor(ref, hex),
    (prev, hex) =>
      prev
        ? {
            ...prev,
            color: { hex, rgb: hexToRgb(hex) },
            color_temp_k: null,
          }
        : prev,
    (hex) => `Color ${hex.toUpperCase()}`,
    (hex) => ({ color: { hex, rgb: hexToRgb(hex) }, color_temp_k: null }),
  );

  const temperature = useOptimisticDeviceMutation<number>(
    { label: "temperature" },
    (ref, kelvin) => api.setTemperature(ref, kelvin),
    (prev, kelvin) =>
      prev ? { ...prev, color_temp_k: kelvin, color: null } : prev,
    (kelvin) => `Temperature ${kelvin}K`,
    (kelvin) => ({ color_temp_k: kelvin, color: null }),
  );

  return { power, brightness, color, temperature };
}

/**
 * Fire-and-forget mutations that only invalidate + toast.
 */
export function useApplyMutation<TResult>(
  label: string,
  fn: (args: { ref: string; vars: TResult }) => Promise<unknown>,
  successDetail?: (vars: TResult) => string,
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ ref, vars }: { ref: string; vars: TResult }) => fn({ ref, vars }),
    onSuccess: (_data, { ref, vars }) => {
      for (const key of deviceKeys(ref)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast({
        variant: "info",
        title: `${label} applied`,
        description: successDetail?.(vars),
      });
    },
    onError: (err) => {
      toast({ variant: "error", title: `${label} failed`, description: errMessage(err) });
    },
  }).mutateAsync;
}

export interface GroupRunVars {
  command: string;
  /** member refs — used to record intents so plates hold the commanded value */
  members: string[];
}

/** Broadcast a CLI-style command to a group; records intents per member. */
export function useGroupRun() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ name, vars }: { name: string; vars: GroupRunVars }) =>
      api.runGroupCommand(name, vars.command),
    onMutate: ({ name, vars }) => {
      void name;
      for (const ref of vars.members) {
        recordIntentForCommand(ref, vars.command);
      }
    },
    onSuccess: (data, { name, vars }) => {
      void name;
      const failed = data.results.filter((r) => !r.ok);
      if (data.ok) {
        toast({
          variant: "ok",
          title: `Group "${vars.command}" sent`,
          description: `${data.results.length} device${data.results.length === 1 ? "" : "s"} acknowledged`,
        });
      } else {
        toast({
          variant: "error",
          title: `Group "${vars.command}" partially failed`,
          description: failed.map((r) => `${r.ref}: ${r.error}`).join(" · "),
        });
      }
      for (const key of [["devices"], ["group-state"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (err) => {
      toast({ variant: "error", title: "Group command failed", description: errMessage(err) });
    },
  }).mutateAsync;
}

/** Map a CLI-style command string onto intent fields for each member. */
function recordIntentForCommand(ref: string, command: string): void {
  const [verb, arg] = command.split(/\s+/, 2);
  if (!arg) return;
  switch (verb) {
    case "power":
      recordIntent(ref, { power: arg === "on" });
      break;
    case "brightness": {
      const value = Number(arg);
      if (Number.isFinite(value)) recordIntent(ref, { brightness: value });
      break;
    }
    case "color": {
      const hex = `#${arg.replace("#", "").toUpperCase()}`;
      recordIntent(ref, { color: { hex, rgb: hexToRgb(hex) }, color_temp_k: null });
      break;
    }
    case "temp": {
      const kelvin = Number(arg);
      if (Number.isFinite(kelvin)) recordIntent(ref, { color_temp_k: kelvin, color: null });
      break;
    }
    default:
      break;
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/* -------------------------------------------------- T10 — v3 endpoint hooks */

/**
 * The manual "that is not what I see" reset (§3.6) — clears the ledger entry
 * server-side. Returns 204/no body, so there is no optimistic state to apply
 * (the honest next state is "unknown," decided by the server's own merge
 * rules, not guessed here); invalidates so the next read reflects it.
 */
export function useDeleteActiveMode() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (ref: string) => enqueueWrite(ref, () => api.deleteActiveMode(ref)),
    onSuccess: (_data, ref) => {
      for (const key of deviceKeys(ref)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast({ variant: "info", title: "Active mode reset", description: ref });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Reset failed", description: errMessage(err) });
    },
  }).mutateAsync;
}

/**
 * Save a studio-authored effect as a real, playable `scenes/*.json` file.
 * Fire-and-forget: T13's "Save as effect" does zero device I/O, so there is
 * nothing to optimistically preview — only the library list changes.
 */
export function useCreateEffect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (body: EffectCreateRequest) => api.createEffect(body),
    onSuccess: (effect) => {
      void queryClient.invalidateQueries({ queryKey: ["effects"] });
      toast({
        variant: "ok",
        title: "Effect saved",
        description: `${effect.name} · ${effect.file}.json`,
      });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Save effect failed", description: errMessage(err) });
    },
  }).mutateAsync;
}

/**
 * §5.3's honesty mechanism, bundled: the persisted calibration (`calibrated:
 * false` is the normal, expected state — never an error) plus `save`, the
 * PUT that records a completed calibration-wizard run. Query fields
 * (`data`/`isLoading`/`error`/…) are spread directly onto the return value
 * alongside `save`, so callers destructure both in one place:
 * `const { data, save } = useSegmentCalibration(ref)`.
 */
export function useSegmentCalibration(ref: string | null) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const query = useQuery({
    queryKey: ["segment-calibration", ref],
    queryFn: () => api.getSegmentCalibration(ref as string),
    enabled: ref !== null,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (body: SegmentCalibrationRequest) =>
      api.putSegmentCalibration(ref as string, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["segment-calibration", ref] });
      toast({ variant: "ok", title: "Calibration saved" });
    },
    onError: (err) => {
      toast({ variant: "error", title: "Calibration save failed", description: errMessage(err) });
    },
  }).mutateAsync;

  return { ...query, save };
}

/**
 * §6.2/§6.6 — crontab-discovered automation (wake-ramp + any other
 * govee-cli cron line). Polled coarser than device state (the endpoint
 * shells out up to twice and is itself cached 30-60s server-side); a
 * `crontab.readable === false` payload is a normal, first-class response
 * here, not a query error — the panel/timeline own rendering that honestly.
 */
export function useExternalSchedules() {
  return useQuery({
    queryKey: ["schedules-external"],
    queryFn: api.externalSchedules,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useWakeRampAction(action: "arm" | "disarm") {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fn = action === "arm" ? api.armWakeRamp : api.disarmWakeRamp;

  return useMutation({
    mutationFn: fn,
    onSuccess: (entry) => {
      // Optimistic-by-fresh-fetch: the response IS the freshly re-read entry
      // (§6.2 — arm state is always re-read live, never cached client-side
      // across the action), so splice it straight into the cached list.
      queryClient.setQueryData<ExternalSchedule>(["schedules-external"], (old) =>
        old
          ? {
              ...old,
              entries: old.entries.map((e) => (e.id === entry.id ? entry : e)),
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["schedules-external"] });
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      toast({
        variant: "ok",
        title: action === "arm" ? "Wake-ramp armed" : "Wake-ramp disarmed",
      });
    },
    onError: (err) => {
      toast({
        variant: "error",
        title: action === "arm" ? "Arm failed" : "Disarm failed",
        description: errMessage(err),
      });
    },
  }).mutateAsync;
}

export function useWakeRampArm() {
  return useWakeRampAction("arm");
}

export function useWakeRampDisarm() {
  return useWakeRampAction("disarm");
}
