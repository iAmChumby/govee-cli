/**
 * Typed client for the govee-cli sidecar (WEBUI_SPEC.md §4).
 *
 * Every response shape here mirrors the FastAPI routers exactly; when the
 * sidecar changes, this file and the spec change together. Errors arrive as
 * {error:{code,message}} — they are unwrapped into ApiError so UI code can
 * toast `err.message` directly.
 */

export type Transport = "cloud-v1" | "cloud-v2" | "ble";

export interface LightColor {
  hex: string;
  rgb: [number, number, number];
}

export interface Capabilities {
  segments: boolean;
  segment_brightness: boolean;
  scenes: boolean;
  diy: boolean;
  music: boolean;
  toggles: string[];
  temp_min: number;
  temp_max: number;
  segment_count_cloud: number;
  segment_count_ble: number;
  prefer_ble_effects: boolean;
}

/** Normalised device state — the shape every state-bearing endpoint returns.
 *  Nullable fields are unknowns: BLE devices report no readable state. */
export interface DeviceState {
  ref: string;
  id: string;
  model: string | null;
  name: string | null;
  transport: Transport;
  online: boolean | null;
  power: boolean | null;
  brightness: number | null;
  color: LightColor | null;
  color_temp_k: number | null;
  capabilities?: Capabilities;
}

export interface DeviceSummary {
  ref: string;
  id: string;
  model: string | null;
  name: string | null;
  transport: Transport;
  online: boolean | null;
  power: boolean | null;
  brightness: number | null;
  color: LightColor | null;
  color_temp_k: number | null;
}

export interface Health {
  status: string;
  version: string;
  mock: boolean;
  scheduler: boolean;
}

export interface FirmwareScene {
  name: string;
  param_id: number;
  scene_id: number;
}

export interface DiyScene {
  name: string;
  value: number;
}

export interface Snapshot {
  name: string;
  value: number;
}

export interface MusicMode {
  key: string;
  value: number;
}

export interface ToggleInfo {
  instance: string;
  verified: boolean;
}

export interface EffectInfo {
  file: string;
  name: string;
  fps: number;
  loop: boolean;
  segments: number;
  segment_ids: number[];
}

export interface PlayingEffect {
  device: string;
  file: string;
  fps: number;
  transport: string;
  started_at: string;
}

export interface ScheduleRule {
  id: string;
  name: string;
  time: string;
  days: string[];
  command: string;
  enabled: boolean;
  device: string | null;
}

export interface GroupRunResult {
  ref: string;
  id: string;
  ok: boolean;
  error?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "Sidecar unreachable on :6057");
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = "http_error";
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // non-JSON error body — fall back to status text
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

/* ---------------------------------------------------------------- queries */

export const api = {
  health: () => request<Health>("/health"),

  devices: () =>
    request<{ devices: DeviceSummary[] }>("/devices").then((r) => r.devices),

  deviceState: (ref: string) =>
    request<DeviceState>(`/devices/${encodeURIComponent(ref)}/state`),

  discover: () => post<{ devices: DeviceSummary[] }>("/devices/discover"),

  setPower: (ref: string, on: boolean) =>
    put<DeviceState>(`/devices/${encodeURIComponent(ref)}/power`, { on }),

  setBrightness: (ref: string, value: number) =>
    put<DeviceState>(`/devices/${encodeURIComponent(ref)}/brightness`, { value }),

  setColor: (ref: string, hex: string) =>
    put<DeviceState>(`/devices/${encodeURIComponent(ref)}/color`, { hex }),

  setTemperature: (ref: string, kelvin: number) =>
    put<DeviceState>(`/devices/${encodeURIComponent(ref)}/temperature`, { kelvin }),

  setSegments: (
    ref: string,
    body: {
      segments: string | number[];
      hex?: string;
      brightness?: number;
    },
  ) => post<{ applied: object; state: DeviceState }>(
    `/devices/${encodeURIComponent(ref)}/segments`,
    body,
  ),

  scenes: (ref: string) =>
    request<{ scenes: FirmwareScene[]; cached: boolean }>(
      `/devices/${encodeURIComponent(ref)}/scenes`,
    ),

  applyScene: (ref: string, name: string) =>
    put<{ applied: FirmwareScene }>(
      `/devices/${encodeURIComponent(ref)}/scenes?refresh=0`,
      { name },
    ),

  diyScenes: (ref: string) =>
    request<{ scenes: DiyScene[] }>(
      `/devices/${encodeURIComponent(ref)}/diy`,
    ).then((r) => r.scenes),

  applyDiy: (ref: string, name: string) =>
    put<{ applied: DiyScene }>(`/devices/${encodeURIComponent(ref)}/diy`, { name }),

  snapshots: (ref: string) =>
    request<{ snapshots: Snapshot[] }>(
      `/devices/${encodeURIComponent(ref)}/snapshots`,
    ).then((r) => r.snapshots),

  applySnapshot: (ref: string, nameOrId: string) =>
    put<{ applied: Snapshot }>(`/devices/${encodeURIComponent(ref)}/snapshots`, {
      name_or_id: nameOrId,
    }),

  musicModes: (ref: string) =>
    request<{ modes: MusicMode[]; supported: boolean }>(
      `/devices/${encodeURIComponent(ref)}/music`,
    ),

  applyMusic: (
    ref: string,
    body: {
      mode: string;
      sensitivity?: number;
      auto_color?: boolean;
      hex?: string;
    },
  ) => put<{ applied: { mode: string; sensitivity: number } }>(
    `/devices/${encodeURIComponent(ref)}/music`,
    body,
  ),

  toggles: (ref: string) =>
    request<{ toggles: ToggleInfo[] }>(
      `/devices/${encodeURIComponent(ref)}/toggles`,
    ).then((r) => r.toggles),

  applyToggle: (ref: string, instance: string, on: boolean) =>
    put<{ applied: { instance: string; on: boolean } }>(
      `/devices/${encodeURIComponent(ref)}/toggles`,
      { instance, on },
    ),

  groups: () =>
    request<{ groups: Record<string, string[]> }>("/groups").then(
      (r) => r.groups,
    ),

  groupState: (name: string) =>
    request<{
      group: string;
      devices: DeviceState[];
      errors: { ref: string; message: string }[];
    }>(`/groups/${encodeURIComponent(name)}/state`),

  runGroupCommand: (name: string, command: string) =>
    post<{ ok: boolean; results: GroupRunResult[] }>(
      `/groups/${encodeURIComponent(name)}/run`,
      { command },
    ),

  schedules: () =>
    request<{ schedules: ScheduleRule[] }>("/schedules").then(
      (r) => r.schedules,
    ),

  createSchedule: (body: {
    name: string;
    time: string;
    days: string[];
    command: string;
    device?: string;
  }) => post<ScheduleRule>("/schedules", body),

  setScheduleEnabled: (id: string, enabled: boolean) =>
    request<ScheduleRule>(`/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  deleteSchedule: (id: string) =>
    request<{ deleted: string }>(`/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  effects: () =>
    request<{ effects: EffectInfo[] }>("/effects").then((r) => r.effects),

  playEffect: (device: string, file: string, force?: "ble" | "cloud") =>
    post<PlayingEffect & { note: string | null }>("/effects/play", {
      device,
      file,
      force,
    }),

  stopEffect: (device: string) =>
    request<{ stopped: { device: string; file: string } }>(
      `/effects/playing/${encodeURIComponent(device)}`,
      { method: "DELETE" },
    ),

  playingEffects: () =>
    request<PlayingEffect[]>("/effects/playing"),
};
