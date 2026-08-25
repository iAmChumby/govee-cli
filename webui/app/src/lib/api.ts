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
  /** 0 on a model with no addressable matrix (e.g. H6008) — the paint
   *  studio tab does not appear in that case. */
  matrix_rows: number;
  matrix_cols: number;
  /** True when the last column wraps to touch column 0 (H6022's drum). */
  matrix_wrap_col: boolean;
}

/** WEBUI_V3_SPEC.md §3 — the active-mode ledger's read-side merge result.
 *  Never a guess: `mode`/`confidence` are honest about what can and can't be
 *  known from the cloud (scene/diy/music/snapshot/segments/effect can never
 *  read back above "assumed" — see §3.4). `mode: "unknown"` must render as
 *  unknown, never be treated as an implicit "basic". */
export type ActiveModeKind =
  | "off"
  | "basic"
  | "scene"
  | "diy"
  | "music"
  | "snapshot"
  | "segments"
  | "effect"
  | "unknown";

export type ActiveModeConfidence = "confirmed" | "assumed" | "external" | "unknown";

export type ActiveModeSource = "cli" | "webui" | "schedule" | "group" | null;

export interface ActiveMode {
  mode: ActiveModeKind;
  label: string | null;
  confidence: ActiveModeConfidence;
  source: ActiveModeSource;
  set_at: string | null;
  age_seconds: number | null;
}

/** Normalised device state — the shape every state-bearing endpoint returns.
 *  Nullable fields are unknowns: BLE devices report no readable state.
 *  `active` is always present (never optional) — a device with no ledger
 *  history still gets an honest `{mode: "unknown", ...}` object, not an
 *  absent field a caller might mistake for "not implemented yet". */
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
  active: ActiveMode;
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
  active: ActiveMode;
}

/** WEBUI_V3_SPEC.md §6.5 — replaces the old flat `scheduler: boolean`.
 *  `native` is this process's embedded APScheduler-less poll runner;
 *  `external` summarises crontab-driven automation (wake-ramp and any other
 *  govee-cli cron line) the native runner knows nothing about. */
export interface SchedulerLastFire {
  rule_id: string;
  name: string;
  at: string;
  ok: boolean;
  error?: string;
}

export interface SchedulerNativeHealth {
  alive: boolean;
  poll_seconds: number | null;
  last_cycle_at: string | null;
  last_fire: SchedulerLastFire | null;
}

export interface SchedulerExternalHealth {
  crontab_readable: boolean;
  error: string | null;
  wake_ramp_armed: boolean | null;
  entry_count: number;
}

export interface SchedulerHealth {
  native: SchedulerNativeHealth;
  external: SchedulerExternalHealth;
}

export interface Health {
  status: string;
  version: string;
  mock: boolean;
  scheduler: SchedulerHealth;
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

/* -------------------------------------------------- matrix paint studio §5 */

export interface EffectKeyframe {
  t: number;
  /** 6-digit hex, no leading "#" — matches `scenes/*.json` on disk. */
  color: string;
}

export interface EffectSegment {
  id: number;
  keyframes: EffectKeyframe[];
}

/** The full body of one `scenes/*.json` file — `GET /effects/{file}`.
 *  Distinct from `EffectInfo` (list metadata: segment *count*, not the
 *  keyframes themselves) — this is what the paint studio re-loads onto the
 *  canvas for editing. `description` is optional: hand-authored scene files
 *  may carry one, but `POST /effects` never writes it. */
export interface EffectBody {
  name: string;
  description?: string;
  segments: EffectSegment[];
  loop: boolean;
  fps: number;
}

export interface EffectCreateRequest {
  device: string;
  name: string;
  segments: EffectSegment[];
  loop?: boolean;
  fps?: number;
  force?: "ble" | "cloud";
}

/** §5.3 — the paint studio's honesty mechanism: the default segment→matrix
 *  boundary guess is a hypothesis until a human confirms it against the lit
 *  hardware. `calibrated: false` is the normal, expected state for a device
 *  nobody has calibrated yet — never an error. */
export interface SegmentCalibration {
  calibrated: boolean;
  boundaries: number[] | null;
  permutation: number[] | null;
  calibrated_at: string | null;
}

export interface SegmentCalibrationRequest {
  boundaries: number[];
  permutation: number[];
}

/* ------------------------------------------------------- schedule truth §6 */

export type CrontabSource = "crontab" | "spool" | "snapshot" | "none";
export type ScheduleConfidence = "exact" | "estimated" | "unknown";
export type ExternalEntryKind = "wake-ramp" | "cron";

/** `source` says which of three routes actually answered (live `crontab -l`,
 *  the spool file, or a cached snapshot); `stale_seconds` is set only for
 *  the snapshot route — a cached answer must never be presented as live. */
export interface CrontabStatus {
  readable: boolean;
  error: string | null;
  checked_at: string;
  source: CrontabSource;
  stale_seconds: number | null;
}

export interface WakeRampStatus {
  armed_date: string | null;
  weekdays_always: boolean | null;
  cron_installed: boolean | null;
  today_will_run: boolean | null;
}

export interface ExternalScheduleEntry {
  id: string;
  kind: ExternalEntryKind;
  raw_line: string | null;
  cron_expr: string | null;
  command: string;
  device_hint: string | null;
  duration_minutes: number | null;
  wake_ramp_status: WakeRampStatus | null;
  next_fire: string | null;
  next_fire_confidence: ScheduleConfidence;
  today_occurrences: string[];
  today_occurrences_truncated: boolean;
  parse_error: string | null;
}

export interface ExternalSchedule {
  crontab: CrontabStatus;
  entries: ExternalScheduleEntry[];
}

/* ------------------------------------------------ request meter + rooms §10 */

/** WEBUI_V3_SPEC.md §10.2 — measured counts only, never a percentage of a
 *  limit we invented. `budget_per_day` is `null` whenever the user has not
 *  opted into `request_budget_per_day`; a percentage may only be shown
 *  against that number, and only when it is set. `minutes` is always 60
 *  entries, oldest first, zero-filled for gaps — no holes to misread as a
 *  quiet period that wasn't actually quiet. */
export interface MeterSnapshot {
  day: string;
  v2_today: number;
  v1_today: number;
  rate_limited_today: number;
  errors_today: number;
  v2_last_minute: number;
  v2_last_hour: number;
  minutes: [string, number][];
  budget_per_day: number | null;
}

/** §10 T19 — one captured device inside a room scene, verbatim from
 *  `ledger.read_one()` plus the live basics. `mode`/`label`/`payload` are
 *  never invented here — see `ActiveModeKind`'s `"unknown"` case. */
export interface CapturedDevice {
  device_id: string;
  model: string | null;
  power: boolean;
  brightness: number | null;
  color: [number, number, number] | null;
  color_temp_k: number | null;
  mode: ActiveModeKind;
  label: string | null;
  payload: Record<string, unknown> | null;
}

/** `GET /rooms` list item. Carries the full capture, not just counts: room
 *  scenes are a local file, so the devices cost nothing extra to send, and a
 *  card can only tint itself from the palette it actually captured if it has
 *  that palette on hand. */
export interface RoomSceneSummary {
  name: string;
  created_at: string;
  device_count: number;
  unknown_count: number;
  devices: CapturedDevice[];
}

/** `POST /rooms` response — the saved scene plus the devices whose mode was
 *  `"unknown"` at capture time (§10, T22), so the capture UI can tell the
 *  user their capture is incomplete before they rely on it. */
export interface RoomSceneCaptureResult extends RoomSceneSummary {
  /** Refs whose mode was `"unknown"` at capture time. A capture taken while
   *  devices read unknown is close to worthless, and the user should learn
   *  that here rather than at restore time. */
  unknown: string[];
}

export interface RoomSceneRestoreStepResult {
  ref: string;
  ok: boolean;
  skipped_reason?: string;
  error?: string;
}

/** `POST /rooms/{name}/restore` response. One failing or skipped device
 *  never aborts the rest — `ok` is the aggregate, `results` is per-device. */
export interface RoomSceneRestoreResult {
  name: string;
  ok: boolean;
  results: RoomSceneRestoreStepResult[];
}

/** `PUT /devices/{ref}/active-mode` body (§10 T23) — corrects the ledger's
 *  record of what is playing. `mode` is constrained server-side to
 *  `ActiveModeKind`; this route sends no device command. */
export interface ActiveModeSetRequest {
  mode: ActiveModeKind;
  label?: string | null;
  payload?: Record<string, unknown> | null;
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

  // 204 No Content (DELETE /active-mode, PUT /segment-calibration) carries no
  // body — calling .json() on it throws a SyntaxError on an empty string.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
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

  /** §3.6 — the manual "that is not what I see" reset. Clears the ledger
   *  entry entirely (not set to "unknown" — an absent key IS unknown). */
  deleteActiveMode: (ref: string) =>
    del<void>(`/devices/${encodeURIComponent(ref)}/active-mode`),

  getEffect: (file: string) =>
    request<EffectBody>(`/effects/${encodeURIComponent(file)}`),

  createEffect: (body: EffectCreateRequest) =>
    post<EffectInfo>("/effects", body),

  getSegmentCalibration: (ref: string) =>
    request<SegmentCalibration>(
      `/devices/${encodeURIComponent(ref)}/segment-calibration`,
    ),

  putSegmentCalibration: (ref: string, body: SegmentCalibrationRequest) =>
    put<void>(`/devices/${encodeURIComponent(ref)}/segment-calibration`, body),

  externalSchedules: () => request<ExternalSchedule>("/schedules/external"),

  armWakeRamp: () =>
    post<ExternalScheduleEntry>("/schedules/external/wake-ramp/arm"),

  disarmWakeRamp: () =>
    post<ExternalScheduleEntry>("/schedules/external/wake-ramp/disarm"),

  meter: () => request<MeterSnapshot>("/meter"),

  rooms: () =>
    request<{ scenes: RoomSceneSummary[] }>("/rooms").then((r) => r.scenes),

  captureRoom: (name: string) =>
    post<RoomSceneCaptureResult>("/rooms", { name }),

  deleteRoom: (name: string) => del<void>(`/rooms/${encodeURIComponent(name)}`),

  restoreRoom: (name: string) =>
    post<RoomSceneRestoreResult>(`/rooms/${encodeURIComponent(name)}/restore`),

  /** §10 T23 — corrects the record, never the light. The route actually
   *  returns the full merged device state (`overlay_active_mode`'s
   *  `{...state, active}`, same shape as `GET /devices/{ref}`) rather than
   *  a bare `ActiveMode` — verified against the live route in mock mode:
   *  a `PUT` response includes `capabilities` and every basic field, not
   *  just `active`. Typing this as `ActiveMode` would make `.mode` read
   *  `undefined` off the real payload (the mode lives at `.active.mode`)
   *  for any future caller that used the return value directly. */
  setActiveMode: (ref: string, body: ActiveModeSetRequest) =>
    put<DeviceState>(`/devices/${encodeURIComponent(ref)}/active-mode`, body),
};
