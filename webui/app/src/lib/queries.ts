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
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { api, ApiError, type DeviceState, type DeviceSummary } from "@/lib/api";
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
    queryFn: api.devices,
    refetchInterval: POLL_MS,
  });
}

export function useDeviceState(ref: string | null) {
  return useQuery({
    queryKey: ["device", ref],
    queryFn: () => api.deviceState(ref as string),
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
    queryFn: () => api.groupState(name as string),
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
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ ref, vars }: { ref: string; vars: TVars }) =>
      mutationFn(ref, vars),
    onMutate: async ({ ref, vars }) => {
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
      queryClient.setQueryData(["device", ref], state);
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      toast({
        variant: "ok",
        title: successTitle(vars),
        description: `${meta.label} · ${state.transport}`,
      });
    },
  }).mutateAsync;
}

/**
 * Returns stable mutate helpers. Each takes {ref, ...vars}; each is
 * optimistic and self-toasting.
 */
export function useDeviceControls() {
  const power = useOptimisticDeviceMutation<boolean>(
    { label: "power" },
    (ref, on) => api.setPower(ref, on),
    (prev, on) => (prev ? { ...prev, power: on } : prev),
    (on) => (on ? "Powered on" : "Powered off"),
  );

  const brightness = useOptimisticDeviceMutation<number>(
    { label: "brightness" },
    (ref, value) => api.setBrightness(ref, value),
    (prev, value) => (prev ? { ...prev, brightness: value } : prev),
    (value) => `Brightness ${value}%`,
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
  );

  const temperature = useOptimisticDeviceMutation<number>(
    { label: "temperature" },
    (ref, kelvin) => api.setTemperature(ref, kelvin),
    (prev, kelvin) =>
      prev ? { ...prev, color_temp_k: kelvin, color: null } : prev,
    (kelvin) => `Temperature ${kelvin}K`,
  );

  return { power, brightness, color, temperature };
}

/** Fire-and-forget mutations that only invalidate + toast. */
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

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}
