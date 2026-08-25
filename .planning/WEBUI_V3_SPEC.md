# Filament Web Console — v3 Implementation Contract

Status: ready for execution. This document is self-contained — an implementation agent
should not need to read any prior design discussion to build from it. Ground truth was
verified live against real hardware on 2026-08-25; where this spec makes an assumption
that hasn't been verified on hardware, it says so explicitly in the relevant section.

Repo root: `/home/chumby/projects/govee-cli`
Backend package: `govee_cli/` (CLI + library) and `webui/api/` (FastAPI sidecar, port 6057)
Frontend: `webui/app/` (Next.js App Router)

---

## 1. What is wrong today

### 1.1 "The GUI does not match what I see in real life" (the #1 complaint)

**Root cause**: the Govee cloud API is structurally blind to scene/DIY/music state. A live
`/device/state` probe on the H6022 (Shelf Lamp) returns `powerSwitch 1, brightness 65,
colorRgb 0, colorTemperatureK 2700, segmentedColorRgb "", lightScene "", musicMode "",
diyScene "", snapshot ""` while the lamp is physically showing a slow blue-to-magenta blob
morph — the DIY scene named `sleep`. The console renders warm white 2700K because that is
all the API will ever say; `http_v2.py`'s `get_state()` docstring documents this as
permanent, not a bug: scene/segment/music/diy instances always read back empty string.
`normalize_state()` (webui/api/deps.py:399-454) explicitly ignores those fields today.
No amount of polling frequency or heuristics recovers this from the cloud. The only fix is
a durable local record of what **we** last commanded, honestly labeled as unverifiable —
see §3.

Two existing near-misses are not that record: `WriteEcho` (webui/api/deps.py) is
in-memory, per-process, 8-second TTL — built to paper over a few seconds of cloud
read-after-write lag, not to remember a scene running for hours, and is wiped by every
sidecar restart. `PlaybackManager` (webui/api/playback.py) tracks locally-played keyframe
effects but is also pure in-memory and never intersects `WriteEcho` or device state.
Neither is written to by `webui/api/routers/scenes.py`'s scene/DIY/music/snapshot/segment
routes today — even the web console's own scene buttons update nothing durable.

### 1.2 "The Schedules page shows 0 rules but a light changes every morning"

**Root cause**: `~/.config/govee-cli/schedule.json` is genuinely `[]` — the Schedules
page is accurately rendering an empty native rule store. The thing that actually fires
every morning is a **plain crontab line**, entirely outside this data model:

```
30 6 * * * /home/chumby/.local/bin/wake-ramp run
```

`wake-ramp` is a bash script (not govee-cli) that ramps only **"Light Bars"** from 1% to
50% brightness at 2000K over 06:30–07:00 in 16 steps, weekdays always, weekends only when
armed via a flag file at `~/.config/wake-ramp/armed`. It has its own `run`/`arm`/
`disarm`/`status` subcommands, its own retry/backoff, and its own `flock` guard. None of
this is representable in the `ScheduleRule` shape (`{id, name, time, days, command,
enabled, device}`) — there is no multi-step ramp concept, no arm/disarm state, no
flag-file awareness. `schedules/page.tsx:21`'s comment claiming "the embedded sidecar
scheduler does the firing" is false for this automation. Live-confirmed: the armed flag
file does not currently exist, so `wake-ramp` will skip the next Saturday/Sunday morning
until re-armed.

### 1.3 Segment painting is worse than the Govee app, and the Govee app itself is limited

**Root cause**: the cloud transport can only address 15 linear segments on the H6022 (the
lamp is actually a 132-LED, 12-column × 11-row wrapped matrix — CLAUDE.md and
`transport.py`'s own docstring call the 15-segment API "a template, not the lamp's
geometry," interpolated onto the matrix by an undocumented firmware rule) and is
rate-limited to roughly 2 requests/second, so true per-LED matrix streaming is not
possible over cloud v2. Today's `SegmentRail` (stage.tsx:507-543) is a flat row of 15
button cells rendered **beside** the lamp graphic with no direction-of-motion concept and
no relationship to the visible 12×11 `MatrixLattice` SVG, which is purely decorative
(zero data binding, confirmed in the stage-and-design-system review). The Govee app gives
users a draw grid with a direction-of-motion picker; ours gives buttons. §5 designs a
studio that is honest about the quantization the Govee app hides, adds real tools it
lacks, and works within the same hardware envelope.

### 1.4 Duplicated/drifting controls and an unstable Schedules health signal

Secondary issues folded into this pass: `QUICK_COLORS`/`TEMP_PRESETS` are duplicated
between `page.tsx`'s `DevicePlate` and `control-deck.tsx`'s `LightTab`; and
`Health.scheduler` (rendered in both `StatusStrip` and `ConnectionSection`) reflects only
the sidecar's own idle embedded scheduler, giving zero signal about `wake-ramp` — a
broken or unarmed ramp looks identical to a healthy one anywhere in the UI. §6 fixes the
health surface; the control duplication is called out as an opportunistic cleanup inside
the relevant work-breakdown tasks but is not a standalone task (too small to isolate
safely without conflicting file ownership with the ledger/motion work also touching those
same components).

---

## 2. Architecture — new modules

All paths are repo-relative from `/home/chumby/projects/govee-cli`.

### Library / CLI (Python)

| Path | Status | Owns |
|---|---|---|
| `govee_cli/ledger.py` | **NEW** | Active-mode ledger: read/write/clear against `~/.config/govee-cli/active-mode.json`, flock-guarded atomic writes. |
| `govee_cli/transport.py` | MODIFIED | Add `matrix_rows`, `matrix_cols`, `matrix_wrap_col` fields to `ModelSpec`; populate for H6022/H6056. |
| `govee_cli/config.py` | MODIFIED | Add `segment_calibration: dict \| None` field to `DeviceConfig`. |
| `govee_cli/commands/{power,brightness,color,temp}.py` | MODIFIED | Call `ledger.record_mode()` after a successful command. |
| `govee_cli/commands/{scene,diy,music,snapshot,segments}.py` | MODIFIED | Call `ledger.record_mode()` after a successful command. |
| `govee_cli/commands/daemon.py` | MODIFIED | Call `ledger.record_mode(source="schedule")` inside `_execute_rule`. |
| `/home/chumby/.local/bin/wake-ramp` | MODIFIED | Add `status --json` output mode (new code path, does not change `run`/`arm`/`disarm`/`status` human output). |

### Sidecar (FastAPI, `webui/api/`)

| Path | Status | Owns |
|---|---|---|
| `webui/api/deps.py` | MODIFIED | `overlay_active_mode()` merge function, wired into `read_state()` right after `apply_echo()`; extend `normalize_state()`'s output shape with `active`; extend `capabilities_block()` with matrix fields. |
| `webui/api/routers/devices.py` | MODIFIED | Call `ledger.record_mode()` in `_basic_control` (alongside existing `record_write`); add `DELETE /devices/{ref}/active-mode`. |
| `webui/api/routers/scenes.py` | MODIFIED | Add `ledger.record_mode()` calls to `apply_scene`/`apply_diy`/`apply_snapshot`/`apply_music`/`apply_segments` — this is the single biggest existing gap. |
| `webui/api/playback.py` | MODIFIED | `ledger.record_mode(mode="effect")` on start; downgrade to `mode="basic"` on clean finish; no change on user-initiated stop (see §3.5). |
| `webui/api/routers/effects.py` | MODIFIED | Add `GET /effects/{file}` (full keyframe body) and `POST /effects` (create, validated via `Effect.from_dict`). |
| `webui/api/routers/groups.py` | MODIFIED | Call `ledger.record_mode(source="group")` alongside existing `record_write` path. |
| `webui/api/routers/calibration.py` | **NEW** | `GET`/`PUT /devices/{ref}/segment-calibration`. |
| `webui/api/external_schedule.py` | **NEW** | Crontab discovery, parsing, wake-ramp status shell-out, next-fire computation — see §6. |
| `webui/api/routers/schedules.py` | MODIFIED | Add `GET /schedules/external`, `POST /schedules/external/wake-ramp/{arm,disarm}`. |
| `webui/api/scheduler_runner.py` | MODIFIED | Track `last_cycle_at` and `last_fire` (ok/error); expose via `snapshot()`. |
| `webui/api/mock.py` | MODIFIED | Redirect `ledger.LEDGER_PATH` into the seeded temp dir alongside the existing config/schedule/scene-cache redirects; extend `MockV2.control()` to actually mutate mock state for segment/music/scene fields so mock mode can demo the ledger. |
| `webui/api/schemas.py` | MODIFIED | Add `EffectCreateRequest`, `SegmentCalibrationRequest`. |

### Frontend (`webui/app/src/`)

| Path | Status | Owns |
|---|---|---|
| `lib/api.ts` | MODIFIED | `ActiveMode` type, `DeviceState.active`, new client methods for every new endpoint above. |
| `lib/intent.ts` | MODIFIED | 5th synthetic `IntentField` (`"active_mode"`) for optimistic "applying: sleep…" on scene/DIY buttons. |
| `lib/queries.ts` | MODIFIED | Hooks for active-mode delete, effect create, segment calibration, external schedules, arm/disarm. |
| `lib/motion-engine/` | **NEW dir** | `types.ts`, `palette.ts`, `classify.ts`, `driver.ts`, `canvas-renderer.ts`, `geometry.ts`, `effect-playback.ts`, `use-motion-stage.ts`, `MotionCanvas.tsx` — see §4. |
| `components/stage/stage.tsx` | MODIFIED | `useActiveHsl` priority change for non-basic `active.mode`; mount `MotionCanvas`; promote `MatrixLattice` from decorative to a real per-cell-driven renderer. |
| `app/device/[ref]/paint-studio/` | **NEW dir** | `paint-studio-panel.tsx`, `canvas-grid.tsx`, `use-paint-canvas.ts`, `tools/{flood-fill,gradient-tool,symmetry,eyedropper}.ts`, `palette-bar.tsx`, `device-geometry.ts`, `dual-preview.tsx`, `motion-controls.tsx`, `calibration-wizard.tsx`, `export-dialog.tsx` — see §5. |
| `app/device/[ref]/control-deck.tsx` | MODIFIED | Tab gating swaps `SegmentsPanel` for `PaintStudioPanel` when `capabilities.matrix_rows > 0`; render the Active Mode badge (name/confidence/age) in `ReadoutStrip`. |
| `app/device/[ref]/segments-panel.tsx` | **DELETED** | Superseded by the paint studio for every model that has segments (H6022, H6056 — both matrix-capable per §2's `ModelSpec` fields). |
| `app/schedules/page.tsx` | MODIFIED | Restructure into "Native Rules" + "External Automation" panels. |
| `app/schedules/timeline.tsx` | **NEW** | 24h combined timeline — see §6. |
| `app/schedules/external-panel.tsx` | **NEW** | External automation panel (crontab entries + wake-ramp arm/disarm). |
| `components/shell/status-strip.tsx` | MODIFIED | Restructured scheduler indicator (native dot + weekend-unarmed glyph). |
| `app/settings/connection-section.tsx` | MODIFIED | Full scheduler health breakdown (native + external). |

---

## 3. The active-mode ledger

### 3.1 Storage

One JSON file, sibling to `config.json`/`schedule.json`/`scene-cache.json`, same
directory convention:

```
~/.config/govee-cli/active-mode.json          # data
~/.config/govee-cli/active-mode.json.lock      # flock target, never contains data
```

Shape:

```json
{
  "version": 1,
  "devices": {
    "50:CE:E8:6E:80:C6:50:3F": {
      "mode": "diy",
      "label": "sleep",
      "payload": {"diy_value": 4},
      "source": "cli",
      "set_at": "2026-08-25T02:14:03Z"
    },
    "6D:19:DD:6E:86:46:44:0C": {
      "mode": "off",
      "label": null,
      "payload": null,
      "source": "schedule",
      "set_at": "2026-08-25T06:30:11Z"
    }
  }
}
```

Keyed by the device's cloud id (`device_id`, matching `WriteEcho`'s key convention), not
by ref/alias — a device can have multiple aliases in `config.json`; the ledger has one
entry per physical device.

Fields:
- `mode`: `"off" | "basic" | "scene" | "diy" | "music" | "snapshot" | "segments" | "effect" | "unknown"`
- `label`: human name resolved **at write time** (never a raw numeric ID) — e.g. `"sleep"`,
  not `4`. `null` for `off`/`basic`/`unknown`.
- `payload`: whatever is needed to redisplay or replay this mode — `{scene_id, param_id}`
  for firmware scenes, `{diy_value}` for DIY, `{music_mode, sensitivity}` for music,
  `{segments: [...], rgb}` for segment paints, `{effect_file, transport}` for effects.
  `null` for `off`/`unknown`.
- `source`: `"cli" | "webui" | "schedule" | "group"`. `wake-ramp` shells out to
  `govee-cli`, so its ramp is captured automatically once `brightness.py`/`temp.py` write
  through this ledger — no `wake-ramp`-specific ledger code is needed.
- `set_at`: ISO-8601 UTC, e.g. `"2026-08-25T02:14:03Z"`.

There is **no `confidence` field stored on disk** — confidence is a read-time
computation (§3.6), not a persisted fact, because it can change (cloud drift detected)
without the ledger entry itself changing. There is **no TTL and no time-based decay of
`mode`** — a DIY scene running 3 hours is still `diy: sleep` until superseded by a new
command. Age is only ever computed at read time for display.

### 3.2 Python API — `govee_cli/ledger.py`

```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Literal, Optional

Mode = Literal["off", "basic", "scene", "diy", "music", "snapshot",
               "segments", "effect", "unknown"]
Source = Literal["cli", "webui", "schedule", "group"]

LEDGER_PATH: Path       # ~/.config/govee-cli/active-mode.json (module-level, overridable
                         # by mock.py's install() the same way config._CONFIG_PATH is)
LEDGER_LOCK_PATH: Path  # LEDGER_PATH with suffix ".json.lock"

@dataclass(frozen=True)
class ActiveModeEntry:
    mode: Mode
    label: Optional[str]
    payload: Optional[dict]
    source: Source
    set_at: str  # ISO-8601 UTC, e.g. from datetime.now(timezone.utc).isoformat()

def record_mode(
    device_id: str,
    mode: Mode,
    label: Optional[str],
    payload: Optional[dict],
    source: Source,
) -> None:
    """Best-effort. Runs AFTER the device command already succeeded — must never raise.
    Any OSError/JSONDecodeError during the read-modify-write cycle is caught, logged via
    structlog at WARNING, and swallowed. Never call this before the underlying command
    has been confirmed to succeed."""

def read_all() -> dict[str, ActiveModeEntry]:
    """No lock taken on read. A missing file or JSONDecodeError returns {} — 'no ledger
    entry' is indistinguishable from 'ledger doesn't exist yet', which is correct: both
    mean mode=unknown to every caller."""

def read_one(device_id: str) -> Optional[ActiveModeEntry]: ...

def clear_mode(device_id: str) -> None:
    """Removes the device's key entirely (not set to mode='unknown' — an absent key IS
    unknown, per read_all's contract). Used by the DELETE /active-mode endpoint and by
    power-off... no, power-off WRITES mode='off', it does not clear. clear_mode is only
    for the manual 'this doesn't look right' reset."""
```

**Write algorithm** (`record_mode`), mirroring the flock + atomic-replace idiom
`wake-ramp` already uses:

1. Ensure `LEDGER_PATH.parent` exists (`mkdir -p` semantics).
2. Open `LEDGER_LOCK_PATH` for writing (create if absent), acquire an **exclusive
   blocking** `fcntl.flock(fd, LOCK_EX)` — blocking, not `LOCK_NB`: writes are
   microseconds, we want a brief wait, not a skip.
3. Read `LEDGER_PATH` if it exists; on any `OSError`/`JSONDecodeError`, treat as `{"version":
   1, "devices": {}}`.
4. Set `data["devices"][device_id] = asdict(ActiveModeEntry(...))`.
5. Write to `LEDGER_PATH.with_suffix(".json.tmp")`, `fsync` the file descriptor.
6. `os.replace(tmp_path, LEDGER_PATH)` — atomic on the local ext4 filesystem this host
   uses (`os.replace` guarantees any reader sees fully-old or fully-new content, never
   torn writes).
7. Release the flock (`fcntl.flock(fd, LOCK_UN)`), close both file descriptors.
8. The entire body of steps 1–7 is wrapped in `try/except Exception: log.warning(...);
   return` — a ledger write failure must never propagate to the caller, because the
   caller already succeeded at the actual device command.

`flock` is released by the OS even if the holding process crashes mid-write — no
stale-lock cleanup path is needed. Reads take no lock at all (safe per `os.replace`'s
atomicity guarantee).

### 3.3 Where it's written — command layer, not transport layer

**Rejected**: hooking inside `GoveeHTTPv2.control()`. BLE effect playback and BLE segment
paint never go through it, and `apply_segments` makes two `control()` calls (color then
brightness) for one user action, which would split into two spurious ledger entries.

**Chosen**: one `ledger.record_mode()` call at the end of each logical mutation, at the
command/router layer:

CLI (`govee_cli/commands/`):
- `power.py`: `off` → `mode="off", label=None, payload=None`. `on` (bare, no other verb
  in the same invocation) → `mode="basic", label=None, payload=None`.
- `brightness.py`: does **not** call `record_mode` at all — brightness-only writes never
  change `mode` (see §3.5).
- `color.py` / `temp.py`: always call `record_mode(mode="basic", label=None,
  payload={"color_rgb": ...} or {"color_temp_k": ...})` — the explicit invalidation of
  any running scene.
- `scene.py`: after `client.set_scene()` succeeds, `record_mode(mode="scene",
  label=<resolved scene name>, payload={"scene_id": id, "param_id": paramId})`.
- `diy.py`: after `client.set_diy_scene()` succeeds, `record_mode(mode="diy",
  label=<resolved diy name>, payload={"diy_value": value})`.
- `music.py`: after `client.set_music_mode()` succeeds, `record_mode(mode="music",
  label=<model-specific mode name, resolved via the same per-model MUSIC_MODES table
  music.py already uses — never the bare integer, since integers are not portable across
  models>, payload={"music_mode": n, "sensitivity": s})`.
- `snapshot.py`: after `client.set_snapshot()` succeeds, `record_mode(mode="snapshot",
  label=<resolved snapshot name if known, else "snapshot #N">, payload={"snapshot_value":
  n})`.
- `segments.py`: **one** call after both the color and (if present) brightness sub-calls
  complete, `record_mode(mode="segments", label=None, payload={"segments": [...],
  "rgb": [r,g,b], "brightness": n|null})`.
- `effect.py`: `mode="effect"` at playback start (`label=<effect file name>,
  payload={"effect_file": ..., "transport": "ble"|"cloud"}`); on clean natural
  completion (loop finished for a non-looping effect, or explicit stop from the CLI),
  downgrade to `mode="basic"` with `payload={"color_rgb": <last frame's color>}` — the
  CLI's own playback loop already knows the last frame it sent.
- `daemon.py` `_execute_rule`: after any successful basic/scene/diy/music/segment command
  fired by a schedule rule, call the *same* command-layer function that CLI invocation
  would have called, with `source="schedule"`. Since the sidecar's `SchedulerRunner`
  delegates to this exact function (`scheduler_runner.py:95-98`), this one hook covers
  both the standalone CLI daemon and the embedded sidecar scheduler.

Sidecar (`webui/api/routers/`):
- `devices.py` `_basic_control`: call `ledger.record_mode(...)` with the same
  mode-selection rules as the CLI's power/color/temp/brightness commands, immediately
  after (not instead of) the existing `record_write` call.
- `scenes.py` `apply_scene`/`apply_diy`/`apply_snapshot`/`apply_music`/`apply_segments`:
  add the missing `ledger.record_mode()` call to each, mirroring the CLI command it
  parallels. This is the single biggest existing gap (confirmed: these currently call
  only `invalidate_state()`).
- `effects.py` `play_effect`/`stop_effect`, plus `playback.py`'s own finish callback:
  `mode="effect"` on start; on the finish callback (natural completion only, not
  user-initiated stop — see §3.5 hazard note) downgrade to `mode="basic"`.
- `groups.py` `run_group_command`: call `ledger.record_mode(source="group")` for each
  member the broadcast successfully reached, using the same verb-to-mode mapping as
  `devices.py`.

`toggle.py`/`apply_toggle` (e.g. `gradientToggle`) do **not** get their own `mode` — fold
into `payload.modifiers` on whatever mode is currently recorded, leaving `mode` itself
unchanged.

Mock mode: `webui/api/mock.py`'s `install()` already redirects `config_mod._CONFIG_PATH`
and `scheduler_mod.SCHEDULE_FILE` to a seeded temp dir — add
`ledger_mod.LEDGER_PATH`/`LEDGER_LOCK_PATH` to that same redirect so demo traffic never
touches the real ledger.

### 3.4 Confidence — computed at read time, never stored

Four values, deliberately not a spectrum implying false precision:

- **`confirmed`** — `mode` is `basic`/`off` AND the live cloud read (power/brightness/
  colorRgb/colorTemperatureK — always reliable, never empty) matches the ledger's
  recorded payload. The only case anything is independently verified.
- **`assumed`** — we sent the command, cloud returned 200. For `scene`/`diy`/`music`/
  `snapshot`/`segments`/`effect` this is the structural ceiling of what can ever be known
  (the cloud always reports empty string for these instances during playback) — it never
  upgrades to `confirmed`, because nothing *can* confirm it. This is the default for
  every non-basic mode, forever.
- **`external`** — `basic` mode only: live cloud brightness/color/temp diverges from the
  ledger's recorded payload with no matching in-flight `WriteEcho` write of ours to
  explain the gap. This is the one case drift **can** be detected — the closest thing to
  "the phone app changed it" the system will ever produce, and it only applies to the 4
  basic fields.
- **`unknown`** — no ledger entry exists (pre-adoption device, or one only ever touched
  from the phone app), the device reads `online: false`, or the user hit the manual reset
  (`DELETE /active-mode`).

**The phone-app scene case, stated plainly**: if the ledger says `diy: sleep` and the
user switches scenes from the Govee phone app, the sidecar cannot detect this —
`colorRgb`/`lightScene`/`diyScene` all continue reading back exactly as before, because
the cloud API gives no live signal during scene playback. No polling frequency or
heuristic fixes this; implementing one would fabricate certainty this system doesn't
have. The honest response is two-fold: (a) never silently upgrade confidence for
non-basic modes — always show `assumed` plus a computed `age_seconds`, so "sleep, 5
seconds ago" reads very differently from "sleep, 6 hours ago," and (b) ship the manual
escape hatch in §3.6.

### 3.5 Invalidation rules

| Action | New ledger state | Confidence | Rationale |
|---|---|---|---|
| Power off | `mode=off, payload=null` | `confirmed` (power is always live-readable) | Supersedes any prior scene/DIY entry unconditionally. |
| Power on, bare (no other verb in the call) | `mode=basic, payload=null` | `assumed` | Does **not** try to resurrect the pre-power-off scene — that can't be verified from the cloud; claiming it would violate the never-claim-what-you-don't-know rule. |
| Plain color or temp write | `mode=basic`, overwrites any scene/diy/music entry | `assumed` until cloud-confirmed | Setting an explicit static color is the strongest available signal a dynamic scene has ended. **Not confirmed on hardware for every model — flagged as a risk, see §9.** |
| Brightness-only write | **No change to `mode`** | unchanged | Treated as a live modifier compatible with a running scene, not a mode-ending action. **Also an unverified per-model assumption in the opposite direction — see §9.** |
| New scene/diy/music/effect/segments command | Overwrites the entry | `assumed` | Last command wins. |
| Effect playback stops (user-initiated, e.g. `DELETE /effects/playing/{ref}`) | **No ledger change** | unchanged | `PlaybackManager` cannot today distinguish "user stopped it" from "it finished naturally" reliably (both remove the same dict entry) — leaving the mode as `effect` until superseded is more honest than guessing it reverted to a static color it may not have. |
| Effect playback finishes naturally (non-looping effect reaches its end) | `mode=basic, payload={color_rgb: <final frame color>}` | `assumed` | The engine knows the last frame it rendered; this is the one effect-stop case with a real answer. |

### 3.6 Read-side merge — the endpoint contract

New function `overlay_active_mode(target, state) -> dict` in `webui/api/deps.py`, called
inside `read_state()` immediately after the existing `apply_echo()` call. Adds one field,
`active`, to `normalize_state()`'s output, and therefore to every response that already
carries normalized state: `GET /devices/{ref}/state`, `GET /devices` (each item), `GET
/groups/{name}/state` (each member).

```json
{
  "active": {
    "mode": "diy",
    "label": "sleep",
    "confidence": "assumed",
    "source": "cli",
    "set_at": "2026-08-25T02:14:03Z",
    "age_seconds": 11040
  }
}
```

Merge logic, in order:

1. `online: false` → `active = {mode: "unknown", label: null, confidence: "unknown",
   source: null, set_at: null, age_seconds: null}` regardless of ledger content.
2. `power: false` (live cloud read) → `active = {mode: "off", confidence: "confirmed",
   ...}`, even if the ledger disagrees — power state is the one thing cloud state proves
   outright.
3. `power: true`, ledger `mode` is `scene`/`diy`/`music`/`snapshot`/`segments`/`effect` →
   return the ledger entry verbatim plus a computed `age_seconds = now - set_at`;
   confidence is always `assumed` for these modes, never auto-upgraded.
4. `power: true`, ledger `mode` is `basic` (or no ledger entry) → compare live
   brightness/color/temp to `ledger.payload`: matches → `confidence = "confirmed"`;
   diverges with no matching in-flight `WriteEcho` entry of ours to explain it →
   `confidence = "external"`, and the **displayed values come from the live cloud read**,
   not the stale ledger payload (this is the detectable phone-app-changed-a-color case).
5. No ledger entry at all → `active = {mode: "unknown", confidence: "unknown", label:
   null, ...}` — deliberately does **not** default to `basic`; inferring "just a static
   color" for a device we've never issued a ledger-recorded command to is itself an
   unverifiable claim.

New endpoint: `DELETE /devices/{ref}/active-mode` → `204 No Content`. Calls
`ledger.clear_mode(device_id)`. This is the manual "this doesn't look right" reset — no
new *write* endpoint exists for setting active mode directly; every ledger write is a
side effect of an existing mutating call, so the ledger can never assert something the UI
itself didn't actually command.

### 3.7 Concurrency

`flock` + atomic `os.replace`, exactly as §3.2 describes. Cross-process visibility: a
CLI-issued write becomes visible to the sidecar within one poll cycle (≤10s, the existing
device-state poll interval) since the sidecar re-reads the file on its next
`read_state()` call (mtime-cached to avoid re-parsing on every single poll tick — cache
the parsed dict keyed by the file's `st_mtime_ns`, re-parse only when it changes). Two
near-simultaneous writers to the same device (a double-click in two browser tabs, or
CLI+webui racing) are serialized by `flock` so the file reflects whichever write executed
last — accepted as a rare, low-stakes race: the next command or next poll self-corrects,
and Govee's own cloud gives no stronger ordering guarantee to build against anyway.

---

## 4. The motion engine

Renders each device's stage to visually resemble what the lamp is actually doing, sourced
from `ActiveMode` (§3). Pure client-side consumer — no backend dependency beyond the
`active` field landing in `DeviceState` (§3.6). Until that field is populated, the engine
renders the existing solid-color fallback with zero regression.

### 4.1 Rendering substrate: Canvas2D, one context per stage

- **Not WebGL**: iOS Safari enforces a small concurrent-WebGL-context ceiling and drops
  contexts under memory pressure — a dashboard grid of `DevicePlate` mini-stages is
  exactly that multi-context scenario.
- **Not SVG filters** (`feTurbulence`/`feDisplacementMap`): animating filter primitives
  every frame is a known Safari jank source, and per-instance filter graphs multiply
  DOM/paint cost across many simultaneous stages.
- **Not the existing CSS spring system** (`Halo`/`EmissionLayers`): right for
  power/brightness/color glow and filament warm-up, structurally wrong for organic
  multi-blob motion or particle fields without stacking dozens of blurred DOM elements.
- **Canvas2D**: one 2D context per stage, radial-gradient blob/plasma/particle rendering,
  resolution-capped at ≤2×DPR regardless of the device's real DPR (a 3× iPhone Pro DPR is
  wasted on soft blurry light patterns), paused via `IntersectionObserver`, SSR-safe (an
  empty `<canvas>` is identical server/client; all drawing happens imperatively inside
  `useEffect`/`requestAnimationFrame`, so no hydration-mismatch risk).

**Performance/battery strategy**: one shared global `requestAnimationFrame` ticker (not N
independent loops per stage), `IntersectionObserver`-gated draw calls, and a
**concurrency tier**: only the device-console "hero" stage plus a capped number
(implementation should tune this empirically against a real iPhone Safari session with
the full dashboard grid visible — start with 4) of visible dashboard "plate" minis run the
real canvas engine; plates beyond the cap fall back to the existing cheap CSS
Breath/Halo loop instead of a redundant canvas context.
`prefers-reduced-motion` renders one static representative frame and never subscribes to
the ticker at all — same convention `useWarmth`/`Breath` already use (skip the JS
animation call entirely, don't rely on the CSS clamp alone).

### 4.2 Module layout — `webui/app/src/lib/motion-engine/`

New directory, additive — does not modify `stage.tsx`'s existing spring/Halo system,
only adds a texture layer inside it.

| File | Owns |
|---|---|
| `types.ts` | Shared interfaces (§4.4). |
| `palette.ts` | Named palette bank; palette resolution from `ActiveMode.color` when present; the color-word override layer (§4.5 layer 1.5). |
| `classify.ts` | `classifyActiveMode()` — the 4-layer resolver (§4.5). |
| `driver.ts` | One global `rAF` ticker singleton; `subscribe`/`unsubscribe`; reduced-motion + visibility gating. |
| `canvas-renderer.ts` | Per-archetype draw functions: `drawBlob`, `drawPlasma`, `drawWave`, `drawChase`, `drawSparkle`, `drawFlicker`, `drawStrobe`, `drawGradientDrift`, `drawRain`, `drawBreathe`. |
| `geometry.ts` | Per-model geometry adapters: bars (2 regions) / matrix (1 drum region) / orb (1 region); normalized 0..1 drawable bounds; shared by hero and mini variants. |
| `effect-playback.ts` | Literal playback path for `kind === "effect"`: TS port of `govee_cli/commands/effect.py`'s `_color_at`/`_frames` sampling against a real `Effect` body + `PlayingEffect.started_at`. |
| `use-motion-stage.ts` | React hook wiring `canvasRef` + geometry + `MotionSpec` into the driver; DPR cap, resize, `IntersectionObserver`, reduced-motion. |
| `MotionCanvas.tsx` | Thin component: `<canvas>` + the hook. Mounted inside `BarsStage`/`MatrixLampStage`/`OrbStage` as a layer above `CYLINDER_SHADING`'s base but below the existing `Halo` glow, **replacing `EmissionLayers`' lit-color layer only when `ActiveMode.mode !== "basic"`/`"off"`** — the solid case renders exactly as it does today, zero regression. |

### 4.3 Integration point in `stage.tsx`

`useActiveHsl` (stage.tsx:102-110) gets a new priority: when `active.mode` is non-basic/
non-off, do **not** render a guessed static HSL from stale `color`/`color_temp_k` —
instead render the `MotionCanvas` texture layer with the mode's `label` and `confidence`
shown as text (e.g. `"sleep — DIY scene, assumed, 3h ago"`) rendered in the existing
`SectionLabel`/caption typographic idiom (`font-mono`, `--tracking-micro`). This is the
direct visual fix for Ground Truth #1. `intent.ts`'s `IntentField` union gains a 5th
synthetic value (`"active_mode"`) so clicking a scene/DIY button shows an optimistic
"applying: sleep…" immediately via the existing 12s-hold pattern. A "not what I see"
control (calling `DELETE /devices/{ref}/active-mode`) appears wherever `active.mode`
isn't `basic`/`off`/`unknown`.

### 4.4 TypeScript interfaces

```ts
// motion-engine/types.ts

export type MotionArchetype =
  | "breathe" | "blob" | "plasma" | "wave" | "chase"
  | "sparkle" | "flicker" | "strobe" | "gradient-drift" | "rain";

export interface Palette {
  /** 2-6 stops, interpolation/blob-assignment order. e.g. sleep -> ["#2b2fb0", "#b0299a"] */
  colors: string[];
  base?: string; // optional under-layer tone; defaults to brightness-scaled black
}

export type ActiveModeKind =
  | "solid" | "firmware_scene" | "diy_scene" | "music_mode"
  | "segment_paint" | "effect";
  // NOTE: this is the motion-engine's own classification input, mapped 1:1 from the
  // ledger's `mode` field: off/basic -> "solid", scene -> "firmware_scene",
  // diy -> "diy_scene", music -> "music_mode", segments -> "segment_paint",
  // effect -> "effect", snapshot -> "solid" (snapshots have no motion of their own —
  // treated as a static capture until proven otherwise).

export interface EffectDescriptor {
  fps: number;
  loop: boolean;
  segments: { id: number; keyframes: { t: number; color: string }[] }[];
  startedAt: number; // epoch ms, from PlayingEffect.started_at
}

export interface ActiveMode {
  kind: ActiveModeKind;
  name?: string;                 // "sleep", "Ocean Wave", raw firmware/DIY name
  effect?: EffectDescriptor;     // only when kind === "effect"
  color?: { r: number; g: number; b: number } | null;
  colorTempK?: number | null;
  confidence: "confirmed" | "assumed" | "external" | "unknown";
  ageSeconds: number | null;
  source: "ui" | "schedule" | "cli" | "group" | "unknown";
}

export interface MotionSpec {
  archetype: MotionArchetype;
  palette: Palette;
  periodSec: number;   // full-cycle duration, archetype-specific meaning
  intensity: number;   // 0..1, independent of device brightness
  sourceName?: string; // stable key for the hash fallback / debug overlay
}

export interface GeometryRegion {
  bounds: { x: number; y: number; w: number; h: number }; // normalized 0..1
  clip?: Path2D | ((ctx: CanvasRenderingContext2D, w: number, h: number) => void);
}

export interface DeviceGeometry {
  model: string;
  kind: "bars" | "matrix" | "orb";
  regions: GeometryRegion[]; // 2 for bars, 1 for matrix drum, 1 for orb
}

// classify.ts
export function classifyActiveMode(mode: ActiveMode, model: string): MotionSpec;

// driver.ts
export interface MotionFrameSubscriber {
  id: string;
  priority: "hero" | "plate";
  draw: (ctx: CanvasRenderingContext2D, t: number, dt: number) => void;
}
export function subscribe(sub: MotionFrameSubscriber): () => void;

// use-motion-stage.ts
export function useMotionStage(params: {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  geometry: DeviceGeometry;
  spec: MotionSpec;
  variant: "full" | "mini";
}): void;
```

### 4.5 Archetype taxonomy and the 4-layer name resolver

10 archetypes, chosen because they cleanly partition the visual language needed:
`breathe` (also the static-color fallback — the common case, unchanged from today),
`blob`, `plasma`, `wave`, `chase`, `sparkle`, `flicker`, `strobe`, `gradient-drift`,
`rain`.

With 94+69+63 real firmware scene names unseen at spec-time and arbitrary user-authored
DIY names, a hardcoded table cannot cover the space and will rot. `classify.ts` resolves
in this order, first match wins:

**Layer 1 — curated override table.** Exact (case-insensitive, whitespace-trimmed) name
match. Seeded from every DIY name in ground truth — see §4.6 for the full table. This is
the only layer allowed to override the resolved *archetype*; it's where `sleep` gets its
hand-tuned blue→magenta blob.

**Layer 1.5 — color-word palette override**, applied independently of which archetype
layer 2/3/4 picks. If the (normalized, lowercased) name contains a literal color word —
`purple`, `violet`, `blue`, `red`, `green`, `orange`, `yellow`, `pink`, `warm`, `cool`,
`white` — the palette is forced to that color's 2-stop bank (defined in `palette.ts`)
regardless of what layer 1/2/3/4 picked for the *archetype*. This lets a name like
`"make a calming, purple"` combine an archetype guess (`breathe`, from the `calming`
keyword in layer 2) with a grounded palette (`purple`) instead of a fully generic guess.

**Layer 2 — keyword classifier.** Normalized name tokens matched against a fixed-priority
table:

| Keyword(s) in name | Archetype |
|---|---|
| fire, candle | flicker |
| lava, blob, nebula | blob |
| wave, ocean | wave |
| comet, chase, spin, gaming, game | chase |
| twinkle, snow | sparkle |
| strobe, disco | strobe |
| rain, waterfall | rain |
| sunrise, fade | gradient-drift |
| calm, calming, sleep, relax | breathe |

**Layer 3 — literal effect playback.** Only reachable when `kind === "effect"` (a
locally-authored keyframe `Effect` with real segment/color/time data, §5): skip guessing
entirely and either play the real data back literally via `effect-playback.ts` (feeding
real per-segment color into geometry regions) or, for a compact preview, classify
statistically off the effect's own color variance/hue-delta — since real data exists here,
a name guess would be strictly worse.

**Layer 4 — deterministic hash fallback.** For anything matching neither layer 1 nor
layer 2 (e.g. `FRoesy2k`, `madisonnnn`): `hash = sum(charCode for c of name.toLowerCase()
where c is alphanumeric) % 4`, mapped `0→breathe, 1→gradient-drift, 2→blob, 3→wave` —
deliberately excluding `strobe`/`sparkle` from the fallback set so an unknown name never
lands on something harsh. The same name always hashes to the same archetype across
sessions (no `Math.random()`), which matters for user trust — "Sunset Glow always looks
like this."

### 4.6 Complete scene-name mapping table (every DIY name in ground truth)

Ground truth lists these DIY scene names (firmware scene names are not enumerated
anywhere in ground truth — only counts: 94 for H6022, 69 for H6056, 63 for H6008 — so
firmware scenes have no override-table entries at spec time and resolve via layers 2–4
at runtime; the override table in `palette.ts` is designed to be extended once real
firmware scene names are visible in production).

| Name | Device(s) | Resolver layer | Archetype | Palette | periodSec | Rationale |
|---|---|---|---|---|---|---|
| `sleep` | H6022, H6056 | 1 (curated override) | `blob` | `["#2b2fb0", "#b0299a"]` (blue → magenta) | 60 | Literal ground-truth case: this is the exact scene Finding #1 describes — a slow blue-to-magenta blob morph. Hand-tuned, not guessed. |
| `O Pai` | H6022 | 4 (hash fallback) | `gradient-drift` (hash=425%4=1) | generic drift bank `["#ffb37a", "#ff7ab3", "#7a9dff"]` | 45 | No keyword match; name gives no signal. |
| `Dark-soho` | H6022 | 4 (hash fallback) | `wave` (hash=859%4=3) | generic ocean bank `["#1e9dd8", "#0b3d91"]` | 20 | No keyword match. |
| `New effect` | H6022 | 4 (hash fallback) | `wave` (hash=951%4=3) | generic ocean bank `["#1e9dd8", "#0b3d91"]` | 20 | No keyword match; deliberately generic placeholder name. |
| `madisonnnn` | H6022 | 4 (hash fallback) | `gradient-drift` (hash=1077%4=1) | generic drift bank `["#ffb37a", "#ff7ab3", "#7a9dff"]` | 45 | Username-style name, no keyword. |
| `FRoesy2k` | H6022, H6056 | 4 (hash fallback) | `gradient-drift` (hash=821%4=1) | generic drift bank `["#ffb37a", "#ff7ab3", "#7a9dff"]` | 45 | No keyword match; same name on both devices hashes identically by design (name-stable, not device-stable). |
| `Gaming` | H6056 | 2 (keyword: "gaming") | `chase` | vivid multi-hue `["#ff003c","#ff9500","#fff700","#00ff85","#00c3ff","#7a00ff"]` | 8 | "Gaming" keyword maps to fast color-cycling chase — the one keyword addition beyond the base table, justified by the name itself implying rapid reactive lighting. |
| `make a calming, purple` | H6056 | 1.5 (color word "purple") + 2 (keyword "calming") | `breathe` | forced to purple 2-stop bank `["#6a2fb0", "#9b4fd6"]` (overrides whatever layer 2 alone would have picked) | 8 | Demonstrates the combined layer: archetype from the "calming" keyword, palette forced by the literal color word "purple" in the name — the strongest signal actually present in the string. |

`hash()` per §4.5: `sum(charCode of normalized alnum chars) % 4`. Computed values shown
above for traceability; do not recompute at review time with a different normalization
and expect the same bucket — the implementation must match `sum % 4` over
lowercased-alphanumeric-only characters exactly as specified.

### 4.7 Music mode — labeled simulation, not literal

The cloud never reports audio-reactive data, so music-mode rendering is a **labeled
simulation**, documented as decorative, not literal — there is no signal to be literal
about. Fixed hand-map, driven by a synthetic ~110bpm clock:

| Music mode name | Archetype | Notes |
|---|---|---|
| Vivid | `plasma` | |
| Strike | `chase` | |
| Rhythm | `wave` | |
| Vibrate | `sparkle` + `flicker` (composited) | |
| Beat | `breathe`, fast period (~0.55s, ~110bpm) | |
| Torch | `flicker`, warm palette | |
| RainbowCircle | `wave`, rainbow multi-stop palette | |
| Shiny | `sparkle` | |

**Critical hazard, not optional**: these 8 names are shared vocabulary but the underlying
integers are **not** — H6056's `MUSIC_MODES` are `Vivid 0, Strike 1, Rhythm 2, Vibrate 3,
Beat 4, Torch 5, RainbowCircle 6, Shiny 7`; H6022's are `Rhythm 3, Rolling 4, Energic 5,
Spectrum 6` (a *different* name set entirely, per CLAUDE.md's own gotcha: "4 is `beat`
here and `rolling` there"). The motion engine must classify by the **resolved name**
(already looked up per-model by `music.py`/the ledger's `label` field, §3.3), never by
the raw integer — reusing the raw integer across models would silently render the wrong
animation, reproducing the exact cross-model bug CLAUDE.md already warns about.

### 4.8 Blob/lava implementation detail (the must-be-recognizable requirement)

3 soft radial-gradient blobs per region (2 independent fields for bars, 1 for the matrix
drum, 1 for the orb), each blob's center driven by slow 2D value-noise sampled at
`t/40..t/70` with a per-blob phase offset so they never visibly sync; hue interpolated
between the palette's stops per blob, phase-offset from its neighbors; composited with
`globalCompositeOperation = "screen"` so overlaps blend into soft purple rather than
harsh edges; softness comes from many-stop radial gradients, not `ctx.filter: blur()`
(cheaper and more consistent across Safari versions). `periodSec` in the 50–70s range so
it unmistakably reads as slow. **Known unverified risk**: `screen` blending of blue +
magenta in sRGB can read as washed-out/cyan-tinted rather than a rich violet — palette
stops likely need empirical tuning against the actual physical lamp, not just picked in
the abstract (see §9 verification plan, which requires visually checking this against the
real Shelf Lamp while `sleep` is active).

### 4.9 Reduced motion and battery

Two independent kill switches, matching the existing convention in `globals.css` and
`stage.tsx`'s `Breath`/`useWarmth`: the global CSS `prefers-reduced-motion` media query
still applies to all existing spring/CSS-transition motion, and separately,
`use-motion-stage.ts` checks `useReducedMotion()` and, when true, **never subscribes to
the driver's ticker at all** — it draws exactly one static representative frame (the
first palette stop's color, no animation) and returns. Battery/perf tiering is per §4.1:
one shared ticker, `IntersectionObserver` gating, hero + capped-plate-count tiering, mini
plates beyond the cap fall back to the pre-existing CSS `Breath`/`Halo` loop rather than a
redundant canvas context.

---

## 5. The matrix paint studio

### 5.1 Data model: one abstract canvas, per-model geometry

New fields on `ModelSpec` (`govee_cli/transport.py`), populated per §2:

```python
matrix_rows: int = 0          # 0 = "no matrix, linear only" (H6008 stays 0)
matrix_cols: int = 0
matrix_wrap_col: bool = False # column N-1 is adjacent to column 0
```

- **H6022**: `matrix_rows=11, matrix_cols=12, matrix_wrap_col=True`. LED index (matches
  CLAUDE.md's own confirmed formula) `led(row, col) = row * 12 + col`.
- **H6056**: `matrix_rows=2` (bar A, bar B), `matrix_cols=48` (an *authoring-resolution*
  choice, not a hardware fact — the bars have no native pixel grid, so 48 gives smooth
  gradients/motion without implying false precision), `matrix_wrap_col=False`.
- **H6008 / unknown**: `matrix_rows=0` → the Paint Studio tab does not appear;
  `control-deck.tsx` falls back to the existing solid-color controls only.

`capabilities_block()` (webui/api/deps.py) projects these three fields into the API's
capabilities JSON 1:1, same pattern as every other `ModelSpec` field.

The canvas itself is a client-side `Uint8ClampedArray` of length `rows * cols * 3`,
addressed by `led(row, col)`. Every tool (brush, fill, gradient, symmetry, eyedropper)
operates on this array and produces a **cell-diff** `{index, from: [r,g,b], to:
[r,g,b]}[]` — the unit of both undo/redo and the live-preview throttle.

### 5.2 Downsampling algorithm (canvas → N segments) — pseudocode

Parameterized by `targetSegmentCount` (15 for H6022 cloud; 6 or 15 for H6056 depending on
the export transport chosen) and a per-device `calibration` array (§5.6).

**Default hypothesis** (used until a device is calibrated) — contiguous, equal(ish) runs
along raster LED order:

```
function defaultBoundaries(totalLeds, segmentCount):
    boundaries = []
    for i in 0..segmentCount:
        boundaries[i] = floor(i * totalLeds / segmentCount)
    # segment[i] covers led indices [boundaries[i], boundaries[i+1])
    return boundaries
```

For H6022: `totalLeds = 132`, `N = 15` → runs of 8 or 9 LEDs each (132 / 15 = 8.8), no
fractional-cell handling needed because canvas cells already map 1:1 to physical LEDs via
`led(row, col)`.

**Gamma-correct color reduction per segment** (avoids the "muddy midpoint" problem naive
sRGB averaging produces, already flagged by the effects-engine review of the existing
linear-RGB effect interpolation):

```
function downsampleFrame(canvas: Uint8ClampedArray, boundaries: number[]) -> RGB[]:
    segments = []
    for i in 0..len(boundaries)-1:
        lo, hi = boundaries[i], boundaries[i+1]
        sumLinear = [0, 0, 0]
        for ledIndex in lo..hi:
            srgb = canvas.slice(ledIndex*3, ledIndex*3+3)
            linear = srgb.map(c => srgbToLinear(c / 255))
            sumLinear += linear
        avgLinear = sumLinear / (hi - lo)
        segments[i] = avgLinear.map(c => round(linearToSrgb(c) * 255))
    return segments
```

`srgbToLinear`/`linearToSrgb` are the standard sRGB EOTF/inverse-EOTF (gamma ≈2.2 with
the linear toe segment) — pure functions, unit-testable exactly like `color.ts`'s
existing `rgbToHsl`/`kelvinToRgb`.

`downsampleFrame()` is one pure function reused for: the static hardware-preview
quantization, and every generated motion frame at export time (§5.4).

**If a `calibration` array exists for the device** (§5.6), the boundaries and/or LED
*permutation* it defines are substituted for `defaultBoundaries()`'s output before
`downsampleFrame()` runs — the averaging logic itself is unchanged, only which LED
indices belong to which segment changes.

### 5.3 Calibration — the honesty mechanism

Because CLAUDE.md and `transport.py`'s docstring both state the segment→matrix mapping is
undocumented, firmware-interpolated behavior, the default boundary algorithm above is a
**defensible hypothesis, not a verified fact**, until a calibration pass has actually run
against the physical device.

`calibration-wizard.tsx` flow: paint 15 maximally-distinct flat reference hues onto the
default-boundary guess, apply them live to the physical lamp (via the existing segments
PUT endpoint), and have the user drag-reorder a 15-chip strip in the UI to match what they
actually see lit, top-to-bottom / left-to-right on the real hardware. The resulting
boundary/permutation array is saved server-side.

Storage: `segment_calibration` field on `DeviceConfig` (`govee_cli/config.py`), sibling
to `static_mac` — **not** the 7-day scene disk cache (`scene-cache.json`), which is
TTL'd and scene-content-keyed, a structurally different lifetime than a stable, rarely-
changing physical-geometry fact.

```json
{"boundaries": [0, 9, 18, 26, 35, 44, 53, 61, 70, 79, 88, 96, 105, 114, 123, 132],
 "permutation": [0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10, 12, 13, 14],
 "calibrated_at": "2026-08-25T14:00:00Z"}
```

Endpoints (`webui/api/routers/calibration.py`, new file):
- `GET /devices/{ref}/segment-calibration` → `{calibrated: bool, boundaries: number[] |
  null, permutation: number[] | null, calibrated_at: string | null}`.
- `PUT /devices/{ref}/segment-calibration` → body `{boundaries, permutation}`, persists
  into `DeviceConfig.segment_calibration`, `204` on success.

Until calibrated, the hardware-preview (§5.5) carries a visible banner: **"approximate
mapping — calibrate for accuracy."** This banner is not optional UI polish — it is the
single most important honesty mechanism in the whole studio, turning an unverifiable
claim into an honest, user-owned, persisted fact instead of a silently-wrong assumption
baked into the code.

### 5.4 Motion: direction + speed, expanded algorithmically at export time

The studio does **not** ask users to hand-keyframe motion for the common case. A static
painted canvas plus a motion descriptor is expanded into real frames at export:

```ts
type Motion =
  | { type: "static" }
  | { type: "scroll" | "rotate" | "pingpong"; axis: "col" | "row"; sign: 1 | -1; periodSeconds: number }
  | { type: "pulse"; periodSeconds: number };
```

- `rotate` is only valid on the wrap-enabled column axis — for the H6022 this *is*
  literal rotation around the drum (`matrix_wrap_col === true` required).
- `scroll`/`rotate`: each frame = the painted canvas shifted by
  `round(frameIndex * cols / (fps * periodSeconds))` cells along `axis`, wrapping via
  modulo where `matrix_wrap_col` is true, clamping otherwise.
- `pingpong`: same shift, but a triangle wave instead of modulo (bounces at the edges) —
  natural for the non-wrapping H6056 bars.
- `pulse`: no spatial shift; global brightness oscillates — a primitive Govee's app
  doesn't expose at all.
- `frameCount = round(periodSeconds * exportFps)`; each shifted frame is fed through the
  same `downsampleFrame()` used for the static preview.

An optional **Mode B** (frame-by-frame flipbook: add-frame, onion-skin the previous frame
at reduced opacity, per-frame duration) is a natural v3.1 extension for hand-authored
non-parametric animation and is **not** required for this spec's scope — both modes
converge on the same emission pipeline below, so it's additive, not a fork, when it comes.

### 5.5 Honest dual preview (spatial AND temporal)

Two synchronized renderers sharing `device-geometry.ts`:

- **Canvas preview** — full resolution, one color per physical LED cell, exactly as
  drawn.
- **Hardware preview** — every cell recolored to its *assigned segment's* downsampled
  color — visibly blocky/banded, showing what the lamp can actually render. Reuses the
  existing `MatrixLattice`/tube SVG geometry from `stage.tsx`, promoted (§2, `stage.tsx`
  task) from purely decorative to a real per-cell-color-driven renderer, extracted into a
  shared component both `DeviceStage` and the studio consume.

Honesty extends to time, not just color: the on-screen preview loop is throttled to the
same `exportFps` the hardware will actually run at (2fps stepped for H6022 cloud) rather
than a smooth 60fps CSS animation, with an optional "artist's intent" toggle showing the
smooth full-rate version side by side, clearly labeled as not what the device will do.

### 5.6 Effect-file emission format

Export walks `frameIndex = 0..frameCount`, computes `downsampleFrame()` per frame, and
emits **one keyframe per segment only when that segment's color changes from its
previously emitted keyframe** — the emit-time mirror of the existing runtime optimization
in `webui/api/playback.py`'s `_play_cloud_blocking` (`changed = {... last_sent.get(seg)
!= rgb}` diffing). This keeps hand-drawn animations from bloating into a
`shelf_violet_flame.json`-sized file (1600 lines) by default.

```json
{
  "name": "shelf-drum-spiral",
  "description": "Matrix Paint Studio — 12x11 wrap, rotate col +1 @ 6s/cycle",
  "fps": 2,
  "loop": true,
  "segments": [
    {"id": 0, "keyframes": [{"t": 0, "color": "3A1E6E"}, {"t": 2000, "color": "7A2E8E"}]},
    {"id": 1, "keyframes": [{"t": 0, "color": "2A0E5E"}, {"t": 2000, "color": "6A1E7E"}]}
  ]
}
```

`fps` is set to the **achievable** rate for the chosen export transport, not the
authoring resolution — `2` for cloud (H6022 is forced to cloud since its BLE protocol is
unimplemented — the AES-128-ECB + RC4 handshake in dvdavd/govee-h6022-ble is not ported),
or up to full BLE rate for H6056 when `spec.prefer_ble_effects` is true.
`targetSegmentCount` for `downsampleFrame()` is picked from the same transport choice, so
the *same* painted canvas + motion descriptor can export two different segment layouts
(6-zone BLE vs 15-zone cloud) for the H6056.

Backend endpoints (`webui/api/routers/effects.py`):
- `POST /effects` — body validated server-side through the existing `Effect.from_dict`
  (the same validator the CLI uses), written to `scenes/<slug>.json` (slug derived from
  `name`, collision-suffixed if needed). Returns the saved `Effect` metadata (matches
  today's `GET /effects` list-item shape).
- `GET /effects/{file}` — returns the **full keyframe body** (today's `GET /effects` is
  metadata-only — this is genuinely new capability, not an extension of an existing
  partial one).

Playback itself is **unchanged**: `POST /effects/play` against the existing
`PlaybackManager`, exactly as it works today, including its existing rate-limit-abort and
per-device lock behavior.

### 5.7 Touch gesture handling

Single Pointer Events code path (`pointerdown`/`move`/`up` with `setPointerCapture`,
matching the existing pattern already used in `ui/dial.tsx`) — no separate touch handler
branch:

- **Drag** (movement > ~6px): continuous stroke; each `pointermove` hit-tests the
  resolved cell and only emits a diff when the touched cell index changes, deduping rapid
  events onto one cell. The whole stroke (`pointerdown` → `pointerup`) groups into **one**
  undo entry.
- **Tap** (movement < 6px, duration < ~200ms): single-cell dab.
- **Long-press** (>~350ms, no movement): quick eyedropper-on-hold — samples that cell
  into the active swatch, reverts to the brush tool on release, with no separate
  persistent mode toggle (mobile has no room for a tool-switch affordance per gesture).
- **Symmetry** mirrors update live during the drag (mirrored cells highlight as the
  stroke forms), not only on release.
- `touch-action: none` scoped to the grid element only, so two-finger page scroll still
  works outside it.
- Palette/tool controls live in a bottom sheet on mobile widths (thumb-reachable),
  condensing to the same icon-nav idiom `top-bar.tsx` already uses for mobile; desktop
  keeps a sidebar.
- **Nothing touches the network mid-stroke.** An explicit "Preview on device" button
  sends only the currently-painted segments' colors, client-throttled to ≤1 req/s
  (reusing the existing segments PUT endpoint) — never one request per pixel touched.
  "Save as effect" writes JSON only, no device I/O at all.

### 5.8 Component breakdown

New, under `webui/app/src/app/device/[ref]/paint-studio/`:

- `paint-studio-panel.tsx` — orchestrator; replaces `segments-panel.tsx`'s role for
  matrix-capable models (H6022, H6056), gated by `capabilities.matrix_rows > 0` in
  `control-deck.tsx`'s tab dispatch.
- `canvas-grid.tsx` — the drawing surface: wrap-aware grid rendering + all pointer/
  gesture handling, purely presentational + gesture, no color logic of its own.
- `use-paint-canvas.ts` — canvas state, undo/redo command stack (diff-based, capped ~100
  entries; Cmd/Ctrl+Z plus toolbar buttons for mobile), active tool state.
- `tools/flood-fill.ts`, `tools/gradient-tool.ts`, `tools/symmetry.ts`,
  `tools/eyedropper.ts` — pure functions producing cell-diffs, unit-testable like
  `color.ts`.
- `palette-bar.tsx` — reuses `SwatchRow`/`HexField` from `color-picker.tsx` rather than a
  third duplicate control.
- `device-geometry.ts` — pure, framework-free: `ledIndex()`, `segmentBoundaries()`,
  `downsampleFrame()`, `applyMotion()`. Shared by preview, export, and the extracted
  `MatrixLattice`.
- `dual-preview.tsx` — `CanvasPreview` + `HardwarePreview`, both consuming the shared,
  now-interactive lattice geometry.
- `motion-controls.tsx` — motion type, axis/direction, speed slider, live-updating
  estimated frame count and estimated cloud-request count before saving.
- `calibration-wizard.tsx` — the per-device reference-pattern flow, §5.3.
- `export-dialog.tsx` — name/description, transport target (choice offered only when
  `spec.prefer_ble_effects` makes both viable, i.e. H6056; H6022 is forced to cloud),
  loop/ping-pong, Save (`POST /effects`) and optional immediate Play.

No changes to `webui/api/playback.py`'s playback engine or `govee_cli/commands/effect.py`
— the studio is purely a producer of the existing `Effect` JSON shape.

### 5.9 What concretely beats the Govee app

1. **Honest quantization, always shown** — the Govee app never shows the blocky reality;
   this studio shows drawn-vs-actual side by side every time, with the same duality
   applied to motion (smooth intent vs stepped hardware reality).
2. **Calibrated, not guessed** — the segment↔matrix mapping is admittedly undocumented
   firmware behavior; rather than silently trusting a hardcoded guess forever,
   calibration is a first-class, persisted, user-driven step.
3. **Real tools** — fill, gradient, eyedropper, symmetry/mirror, multi-level undo/redo.
   The Govee app has none of these.
4. **Produces an artifact, not a black box** — every animation becomes an inspectable,
   git-trackable, CLI-playable, schedule-attachable JSON file in `scenes/`, versionable
   and shareable across devices — vs. Govee's opaque numeric-ID cloud scenes.
5. **Budget-aware by construction** — the export dialog shows estimated request cost
   before saving, reuses the existing diff-on-change batching, and picks BLE
   automatically where that's strictly better (H6056).
6. **One tool, two real hardware geometries** — same canvas/tools/motion model serving
   both the H6022's wrapped matrix and the H6056's linear bars via a per-model geometry
   descriptor.
7. **Composes with the rest of the console** — saved effects appear immediately in the
   existing Effects tab/`PlaybackManager`, run through existing per-device write
   serialization and rate-limit handling, and feed the active-mode ledger (§3) instead of
   being a disconnected island.

---

## 6. Schedule truth

### 6.1 Confidence tiers on next-fire

Three sources, not equally knowable:

1. **Native `ScheduleRule`** (HH:MM + weekday list) — next-fire is exactly computable
   today via `next-fire.ts`; unchanged.
2. **wake-ramp** — next-fire IS deterministic, but only by delegating to the script's own
   logic (its weekday-always/weekend-only-if-armed branch and flag-file consumption live
   inside the bash script, invisible from the crontab text — `"30 6 * * *"` alone looks
   like "every day"). Sourced from the script, not from cron syntax.
3. **Any other govee-cli cron line** — next-fire is only an **estimate** from the raw
   cron expression, since we cannot see whatever internal gating a future script might
   apply (exactly the trap wake-ramp demonstrates). Must be labeled as an estimate, never
   asserted as fact.

Verified live: `/usr/bin/crontab` exists; `crontab -l` as `chumby` returns 7 entries,
exactly one Govee-relevant (`30 6 * * * wake-ramp run`). `apscheduler` is already a
`pyproject.toml` dependency (currently dead code — no import of it exists anywhere in the
tree) so its `CronTrigger.from_crontab()` is reused for tier-3 estimates at zero new
dependency cost.

**Unresolved risk, must be smoke-tested before shipping**: the sidecar's systemd unit may
set `NoNewPrivileges=true`, which can break `/usr/bin/crontab`'s setgid mechanism for
reading the spool file even for a user reading their own crontab. Fallback if `crontab -l`
fails under the running service: read `/var/spool/cron/crontabs/chumby` directly (same
content `crontab -l` would show), adding it to the unit's `ReadOnlyPaths`.

### 6.2 `webui/api/external_schedule.py` — pipeline

```python
def read_crontab() -> CrontabResult:
    """CrontabResult(readable: bool, error: str|None, raw_lines: list[str])
    subprocess.run(["crontab", "-l"], timeout=3, capture_output=True, text=True)
    - FileNotFoundError                         -> readable=False, error="crontab command not found on this host"
    - returncode!=0, stderr matches /no crontab for/i -> readable=True, raw_lines=[]  # legitimately empty
    - returncode!=0 otherwise (perm denied, sandboxing) -> readable=False, error=stderr[:200]
    - TimeoutExpired                            -> readable=False, error="crontab -l timed out" """

def parse_line(line: str) -> ParsedCronLine | None:
    """Skip blank/#-comment lines; split first 5 whitespace fields as cron_expr, rest as command."""

def is_govee_relevant(command: str) -> bool:
    """"wake-ramp" in command OR re.search(r'\\bgovee-cli\\b', command)"""

def classify(parsed: ParsedCronLine) -> Literal["wake-ramp", "cron"]:
    """"wake-ramp" iff command references the wake-ramp binary path specifically."""

def wake_ramp_status() -> dict | None:
    """subprocess ["wake-ramp", "status", "--json"], timeout 3s; None + error string on any failure."""

def next_fire_for_wake_ramp(status: dict, now: datetime) -> tuple[str | None, Confidence]:
    """Mirrors wake-ramp's own next_weekend_target()/cmd_run gating exactly — do not
    shortcut this by re-deriving from the raw cron expression.
    candidates = []
    for i in 0..7: d = today + i
      if d.weekday() < 5 (Mon-Fri): candidates.append(d @ 06:30) unless (i==0 and now already past 06:30)
      else: if status.armed_date == d.isoformat(): candidates.append(d @ 06:30)
    return (min(candidates), "exact") if candidates else (None, "unknown")"""

def next_fire_for_cron(cron_expr: str, now: datetime) -> tuple[str | None, Confidence]:
    """try: t = apscheduler.triggers.cron.CronTrigger.from_crontab(cron_expr)
           return (t.get_next_fire_time(None, now).isoformat(), "estimated")
       except Exception: return (None, "unknown")  # malformed field — never guess"""

def today_occurrences(cron_expr: str, now: datetime, cap: int = 20) -> tuple[list[str], bool]:
    """For the timeline; walk get_next_fire_time from local midnight. Returns
    (occurrences, truncated) — truncated=True past the cap, protecting against a
    pathological '* * * * *' line."""
```

Endpoint: `GET /api/v1/schedules/external`

```json
{
  "crontab": {"readable": true, "error": null, "checked_at": "2026-08-25T18:00:00Z"},
  "entries": [
    {
      "id": "wake-ramp",
      "kind": "wake-ramp",
      "raw_line": "30 6 * * * /home/chumby/.local/bin/wake-ramp run >> ...",
      "cron_expr": "30 6 * * *",
      "command": "/home/chumby/.local/bin/wake-ramp run",
      "device_hint": "Light Bars",
      "duration_minutes": 30,
      "wake_ramp_status": {"armed_date": null, "weekdays_always": true, "cron_installed": true, "today_will_run": true},
      "next_fire": "2026-08-26T06:30:00-04:00",
      "next_fire_confidence": "exact",
      "today_occurrences": [],
      "parse_error": null
    }
  ]
}
```

`next_fire_confidence` is a closed enum: `exact` (native rules, wake-ramp) | `estimated`
(generic cron) | `unknown` (unparseable, or the source itself is unreachable). The
frontend renders these three states with visibly different styling — `unknown` never
silently collapses into a blank cell.

`wake-ramp status --json` (new flag on the existing bash script, additive, does not
change `run`/`arm`/`disarm`/plain-`status` semantics) must emit, via plain `printf` (no
`jq` dependency, since every field is a known-safe enum/date):

```json
{"armed_date": "2026-08-29", "weekdays_always": true, "cron_installed": true,
 "today_will_run": true,
 "ramp": {"min_pct": 1, "max_pct": 50, "kelvin": 2000, "steps": 16,
          "start": "06:30", "end": "07:00", "devices": ["Light Bars"]}}
```

Arm/disarm — shell out verbatim, never touch the flag file directly from Python:

```
POST /api/v1/schedules/external/wake-ramp/arm     -> subprocess ["wake-ramp", "arm"];    returns fresh entry
POST /api/v1/schedules/external/wake-ramp/disarm  -> subprocess ["wake-ramp", "disarm"]; returns fresh entry
```

Scoped to the one script by exact path match — no generic "arm any cron line" affordance.
The external-schedule endpoint's result is cached ~10–30s in the existing `TTLCache`
(spawns up to 2 subprocesses per call; keep this endpoint's poll interval coarse, 30–60s,
not matching the 10s device-state cadence).

### 6.3 Presentation — Schedules page

Two visually distinct panels, never merged into one list (`webui/app/src/app/schedules/`):

**"Native Rules"** (`page.tsx`, largely unchanged) — `RuleRow`, enable `Switch`,
`DeleteRuleButton`, `AddRuleDialog`.

**"External Automation"** (`external-panel.tsx`, new, read-only-but-real):
- Every row: dashed/hairline border (not solid), a lock glyph, a mono micro-label caption
  `source: crontab · read-only` (matches `SegmentRail`'s existing caption idiom).
- `wake-ramp` gets its own row: name "wake-ramp", device chip "Light Bars", the raw ramp
  shape (1%→50% @ 2000K, 06:30–07:00), an armed/not-armed `StatusDot`, and **Arm**/
  **Disarm** buttons calling the two endpoints, optimistically refreshing from the
  response.
- Generic cron entries: raw command + raw `cron_expr` shown verbatim (monospace, matching
  the existing `GroupBroadcast` CLI-string idiom), next-fire rendered per its confidence
  tier, no `Switch`/`Delete`, no arm/disarm.
- `crontab.readable === false` → replace the whole panel body with one banner:
  `"External automation status unknown — could not read crontab ({error}). Lighting may
  still be running on a schedule this page cannot see."` — never render "0 external
  automations" in this state; that's indistinguishable from a genuinely empty crontab and
  is exactly the lie being fixed.
- `crontab.readable === true && entries.length === 0` → a quieter, positive statement:
  `"No external govee-cli automation found in crontab."` — distinguishable in copy and
  tone from the unreadable case.
- **Never** give an external row a `Switch`/`Delete` — the sidecar has no writable
  relationship to a crontab line it doesn't own.

### 6.4 24-hour timeline — `schedules/timeline.tsx` (new)

One horizontal 00:00–24:00 track (`Panel` + hairline ticks, matching the "optical bench"
design language — no shadows, hairline-only), combining native rules (filtered to
`days.includes(today)`) + the external-schedule payload:

- **Native occurrences**: solid accent-colored point/chip at HH:MM, label = rule name;
  disabled rules render at reduced opacity (`springStandard` fade, matching the existing
  `Switch`/`Chip` convention). Clickable → opens that rule for edit.
- **wake-ramp**: rendered as a **duration band** (06:30–07:00), not a point — it's a
  30-minute ramp, not an instant. Solid fill + sunrise glyph if `today_will_run`; dashed
  outline + muted fill if not (disarmed weekend). Tooltip shows the arm state and the two
  action buttons.
- **Generic cron entries**: muted, dashed point markers at each `today_occurrences` time,
  capped at 20 with a `"+N more today"` fallback label past the cap. Tooltip shows the
  raw crontab line verbatim.
- **Now marker**: thin vertical line at the current time, driven by the same 1-tick clock
  pattern `StatusStrip` already uses (`useClock`); percentage-math positioned, no
  `MotionValue` needed (moves once a minute).
- **Unreadable crontab**: the external layer is replaced with a single hatched "unknown"
  band across the whole 24h track; native occurrences still render normally — partial
  knowledge shown as partial, not zeroed out.
- `estimated`-confidence markers get a distinct visual treatment (a `~` prefix on the
  tooltip time, lighter marker) from `exact` ones.

### 6.5 Scheduler-runner health surface

Restructure `Health.scheduler` (currently a single misleading boolean rendered in both
`StatusStrip` and `ConnectionSection`) into:

```ts
scheduler: {
  native: { alive: boolean; poll_seconds: number; last_cycle_at: string | null;
            last_fire: { rule_id: string; name: string; at: string; ok: boolean; error?: string } | null };
  external: { crontab_readable: boolean; wake_ramp_armed: boolean | null; other_govee_cron_count: number };
}
```

Backend: `webui/api/scheduler_runner.py`'s `SchedulerRunner` gains two fields updated
inside `fire_due()`/`_execute()`: `self._last_cycle_at` (set every poll, success or not)
and `self._last_fire` (set per rule, wrapping `_execute` in try/except to capture
`ok`/`error` instead of letting a failure reach only the journal). Expose both via a
`snapshot()` method the health route reads.

Presentation: **`StatusStrip`** (persistent chrome, must stay compact) keeps one dot,
relabeled "native scheduler" instead of bare "scheduler," plus a small secondary glyph
when `wake_ramp_armed === false` on a Friday/Saturday — the one moment a silent skip is
worth surfacing ambiently. **`ConnectionSection`** (Settings, already the detail view)
gets the full breakdown: alive/poll interval/last cycle/last fire ok-or-error, plus the
external block (crontab readable, wake-ramp armed state, count of other matched cron
lines).

**Known, explicitly out-of-scope hazard**: the CLI daemon and the sidecar runner can
still double-fire a native rule if both run simultaneously (independent in-memory
last-fired-minute guards). This spec does not fix that — it only makes the sidecar's own
health honest. A persisted `{rule_id: last_fired_minute}` file would close it but is a
separate future change; do not attempt it as part of this work breakdown.

### 6.6 Never claim what can't be computed — summary rule

- `crontab.readable=false` is first-class, not an edge case: propagated into the
  external-schedule panel (banner, not "0 rows"), the timeline (hatched unknown band, not
  an empty external layer), and the health surface (`crontab_readable: false` shown, not
  silently omitted).
- `next_fire_confidence` is always `exact | estimated | unknown`, never a silent fourth
  case; `unknown` renders as literally "unknown," never a blank field or stale cache.
- wake-ramp's arm state is always re-read live at request time (never cached
  client-side across the arm/disarm action), since the flag file is consumed by the
  script itself.

---

## 7. Visual direction

> Authored as a replacement for the original section 7, which concluded that v2's restrained
> language should be preserved. That is the opposite of the brief: the user asked for an
> over-the-top, high-motion, attention-grabbing console and said explicitly that a choice which
> seems distracting is probably the right one. The full working document, including the CSS
> excerpts too long to inline here, is `.planning/V3_VISUAL_DIRECTION.md`.

## A. The governing metaphor

**This is a front-of-house lighting rig, live, in a dark room, mid-show — not an
optical bench.** An optical bench is a science-lab instrument: precise, inert,
apologetic about its own existence. A FOH rig is a physical control surface built to
be looked at *and* touched in the dark by someone who needs to feel where their hand
is without looking down — backlit faders, RGB indicator rings, channel strips that
glow with the actual color of the signal running through them, big analog-style
readouts you can read from across a dark room. The chassis (the housing, the metal,
the labels silkscreened on it) is deliberately inert and matte so it disappears; the
*signal* (the light itself, and everything reporting on the light) is what the rig
exists to make loud. Every decision below follows from that split: the console is a
piece of hardware built around the light, not a spreadsheet that happens to display a
light's status. "filament" — the app's own wordmark, already carrying an incandescent
warm-up animation — already wants this; v2 just never let it happen anywhere but the
stage instrument itself.

---

## B. The loudness budget — the Chassis/Signal rule

"Make everything loud" produces mush, and the current build's failure mode in reverse
(muting everything to be safe) is just as real a failure. The fix is a named,
explicit hierarchy, applied identically everywhere in this document.

**The Chassis/Signal rule:** every pixel on screen is either **chassis** (the rig's
own housing — it never emits, never carries device color, never animates on its own)
or **signal** (something reporting live device state — it is *allowed* to be the
loudest thing in its neighborhood, and the closer it is to the physical light, the
louder it's allowed to get). Four tiers, strictly ordered:

1. **SIGNAL-PRIME** — the device's actual live emission: `DeviceStage`/`MotionCanvas`
   core, halo, and (new) particle bursts. Full saturation, the real device hue,
   uncapped opacity within the instrument's own bounds. This is the only tier allowed
   to be the single most saturated color on the screen. Nothing else may exceed it.
2. **SIGNAL-SPILL** — color *derived* from SIGNAL-PRIME bleeding onto surrounding
   chassis: card backgrounds, card borders, ambient shadows, control tints, toast
   accent bars. Same hue as tier 1, but opacity/saturation dramatically cut (§C gives
   real numbers) so it reads as light spilling off the fixture, never competes with
   the fixture itself. Also home to the two celebration bursts (§E) — loud but
   deliberately brief.
3. **CONTROL-RESPONSE** — the momentary physics of touching something: press-in
   scale, drag feedback, spring-back. Loud for ~100–300ms, then gone. No ambient
   looping motion beyond what already exists (`Breath`, the wordmark's `dot-breathe`).
4. **CHASSIS** — top bar, nav rail, status strip, section labels, hairlines, panel
   borders in their idle state, body copy, page background. Zero color beyond the
   existing neutral token set, zero animation beyond the two pre-existing ambient
   loops. This tier's silence is what makes tiers 1–3 land — detailed in §G.

Every component in §D is graded against this rule. If a proposed change can't name
its tier, it doesn't ship.

---

## C. Color and light spill

The single best lever available: **the live color of each device bleeds into its own
card — background, border, ambient shadow — and that bleed composes across the page
by literally overlapping, the way light from separate real fixtures pools on a dark
floor.** No new npm dependency; this is `@property`-registered CSS custom properties
plus `color-mix()`, both already load-bearing in this codebase (`tokens.css` already
registers `--glow-alpha`/`--glow-scale`/`--glow-hue`/`--glow-radius`).

### New tokens

`tokens.css` currently registers `--glow-hue`, `--glow-scale`, and `--glow-radius` via
`@property` but **nothing in the codebase reads them** (confirmed by grep — only
`--glow-alpha` has consumers, in `Halo` and `Switch`). They're dead weight. Repurpose
`--glow-radius` as the shared ambient-shadow blur channel (identical meaning either
way: "how far this glow reaches"); leave `--glow-hue`/`--glow-scale` alone so a future
per-instrument use doesn't collide with the new card-level system. Add four new
registered properties, distinctly named `--dev-*` so "this describes the DOM
subtree's live device state" is never confused with `--glow-*` ("this instrument's
own internal emission," `Halo`'s job, unchanged):

```css
/* tokens.css — new, alongside the existing @property block */
@property --dev-hue {
  syntax: "<number>";
  inherits: true;
  initial-value: 36; /* WARM_HSL's hue — matches the off/unknown fallback */
}
@property --dev-sat {
  syntax: "<percentage>";
  inherits: true;
  initial-value: 0%;
}
@property --dev-light {
  syntax: "<percentage>";
  inherits: true;
  initial-value: 50%;
}
@property --dev-alpha {
  syntax: "<number>";
  inherits: true;
  initial-value: 0; /* off/unknown = zero bleed, always */
}
```

`inherits: true` is deliberate: each card sets its own `--dev-*` quartet on its own
root element, and every descendant (`Slider` thumb, `Switch` track, quick-swatch
buttons) reads `var(--dev-hue)` and resolves to *its own card's* value — nearest
definition wins in the cascade. That's how four devices with four colors compose on
one page without any component needing to know about its siblings.

### How it updates without re-rendering React on every frame

Two different update rates, two different mechanisms — the reason this doesn't cost a
per-frame JS loop:

- **Hue/saturation/lightness** change only when device *state* changes (a poll tick or
  an optimistic write lands in the query cache) — not every animation frame. A new
  hook, `useDeviceBleed(ref, hsl, power, brightness)` (`lib/device-bleed.ts`, new),
  writes the three values as an inline `style` object from the already-rerendering
  `DevicePlate`/card component — this is not new render cost, the component already
  re-renders on that same state change today. All the *smoothing* between an old hue
  and a new one is delegated to a plain CSS `transition` on `--dev-hue`/`--dev-sat`/
  `--dev-light` (legal and animatable specifically because they're `@property`
  registered) — zero JS ticking involved.
- **Alpha** (the overall bleed intensity — 0 when off, brightness-scaled when on)
  needs the same continuous, physically-weighted feel as the rest of the instrument's
  glow, so it rides a `motion/react` spring exactly like `useGlow` already does for
  the instrument's own emission — but it's written to the DOM **imperatively** via
  `useMotionValueEvent` calling `cardEl.style.setProperty("--dev-alpha", v)` on a ref,
  never through React state. This is the identical pattern `Halo` already uses for
  `--glow-alpha`; `device-bleed.ts` just applies it one level up, at the card root.

Net effect: no second per-frame JS loop is added anywhere in the chrome layer, which
satisfies the hard 60fps constraint — the motion engine's Canvas2D ticker (§4 of the
spec) remains the only thing driving a `requestAnimationFrame` loop.

### The bleed itself (card-level)

```css
/* globals.css — new, additive, opt-in via a Panel prop (see §D) */
.dev-bleed {
  background-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 14%),
    var(--panel)
  );
  border-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 55%),
    var(--hairline)
  );
  box-shadow: 0 0 var(--glow-radius) -60px
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light) / calc(var(--dev-alpha) * 0.55));
  transition:
    background-color var(--dur-slow) var(--ease-out-soft),
    border-color var(--dur-slow) var(--ease-out-soft),
    box-shadow var(--dur-slow) var(--ease-out-soft),
    --dev-hue var(--dur-slow) var(--ease-out-soft),
    --dev-alpha var(--dur-base) var(--ease-out-soft);
}

:root[data-theme="light"] .dev-bleed,
:root:not(.dark) .dev-bleed {
  /* light theme starts near-white; the same mix ratio reads as a much stronger
     tint against a bright background, so it's cut further here. */
  background-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 8%),
    var(--panel)
  );
}
```

`14%` (dark) / `8%` (light) on the background mix and `55%` on the border are chosen
to keep `--text-hi`/`--text-mid` at ≥4.5:1 against the tinted background even at full
`--dev-alpha` and a saturated device hue — this is a claim, not a fact, and T16's
verify step (§H) requires actually checking it with a contrast tool against the worst
case (a fully-saturated, high-lightness device color like Govee's near-white
`#EAF2FF` swatch), not just asserting the math looks safe.

**Degrading when off:** `power === false` or `online === false` springs `--dev-alpha`
to `0` on `springStandard` (matching `useGlow`'s existing on/off physics) while
`--dev-hue`/`--dev-sat`/`--dev-light` simply hold their last value — the card fades to
flat chassis rather than snapping, and never flashes toward some default hue on the
way down. An off card is required by §B/§G to be the calmest thing on the page; this
is how that's enforced at the token level, not just by convention.

**Composing four different colors on one page:** deliberately **not** a single
averaged "scene color." Averaging red and blue into a muddy purple that matches
neither device would be dishonest and would need new aggregation logic besides.
Instead, each card's own `box-shadow` blur (`--glow-radius`, tuned per breakpoint,
default ~120px on mobile cards) spills a few dozen pixels past its own edges into the
shared `--bg` canvas — so with four differently-colored cards visible in the grid, the
page background genuinely shows four distinct pools of colored light where the cards'
shadows overlap the gaps between them, exactly like real fixtures in a dark room. This
satisfies "the page background itself" from the brief with zero new JS and zero
averaging math — it's a direct, honest consequence of the per-card token already
existing.

---

## D. Component-by-component before/after

Every entry below is tagged with its Chassis/Signal tier from §B.

### Device card (dashboard) — SIGNAL-SPILL for surface, SIGNAL-PRIME for the instrument

**Today:** `Panel` with `p-4`, flat `bg-panel`, hairline border, never changes color;
the live instrument (`DeviceStage variant="mini"`) is pinned at a fixed `h-28`
(112px) regardless of device geometry, stranded above a slider, a mono readout row,
and a wrapped row of six generic swatch buttons — see `IMG_1019.PNG`: the actual light
render occupies maybe 15% of the card's vertical space.

**Becomes:** the `.dev-bleed` treatment from §C on the card root (a new `bleed` prop
on `Panel`, default `false` so every other `Panel` consumer — paint studio, dialogs,
settings — is unaffected); the instrument container sized by `aspect-ratio` instead of
a fixed height so each geometry (bars/matrix/orb) gets proportional space instead of
being squeezed into one generic box; the quick-swatch + temp-preset row collapses into
a single horizontal-scroll "channel strip" dock at the card's bottom edge instead of
wrapping across two rows of dead space.

```tsx
// components/device/device-plate.tsx (new, extracted from page.tsx)
<Panel bleed className="p-4">
  <CardHeader … />
  <Link href={…} className="mt-3 block aspect-[4/3] overflow-hidden rounded-card sm:aspect-[16/10]">
    <DeviceStage state={device} variant="mini" className="h-full" />
  </Link>
  <BrightnessRow … />          {/* slider, tinted per §D "Brightness slider" */}
  <ChannelStripDock … />        {/* horizontal-scroll swatches + temp presets */}
</Panel>
```

```css
/* the dock: one row, scrolls instead of wraps — recovers the vertical space
   the old two-row wrap was spending on padding between rows */
.channel-strip-dock {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-block: 10px;
  border-top: 1px solid var(--hairline);
  mask-image: linear-gradient(to right, transparent, black 12px, black calc(100% - 20px), transparent);
}
```

### Brightness slider — CONTROL-RESPONSE, thumb is SIGNAL-SPILL while dragging

**Today (`ui/slider.tsx`):** neutral `bg-accent` fill and thumb, identical for every
device regardless of color — a red lamp and a white lamp get an identical white
progress bar.

**Becomes:** the fill and thumb inherit `var(--dev-hue)`/`var(--dev-sat)` while
dragging (a real dimmer fader tinted by the channel it drives), reverting to the
neutral `--accent` fill when idle so the *track itself* stays chassis-quiet and only
the *live drag* is loud (this is the Chassis/Signal split applied inside a single
component, not just between components):

```tsx
// slider.tsx — additive `tint?: boolean` prop, default false (no regression)
<motion.div
  className="absolute left-0 h-full rounded-full"
  style={{
    width: fillWidthStyle,
    backgroundColor: tint && dragging
      ? "hsl(var(--dev-hue) var(--dev-sat) var(--dev-light))"
      : "var(--accent)",
  }}
/>
```
```css
/* thumb glow while dragging, tint-aware, compositor-only (opacity/transform) */
.slider-thumb[data-dragging="true"][data-tint="true"] {
  box-shadow: 0 0 0 8px hsl(var(--dev-hue) var(--dev-sat) var(--dev-light) / 0.22);
  transition: box-shadow var(--dur-fast) var(--ease-out-soft);
}
```

### Power switch — CONTROL-RESPONSE + a SIGNAL-SPILL flourish on the "on" flip

**Today (`ui/switch.tsx`):** already the best-built primitive in the system — the
`--glow-alpha`-driven fill and the `pending` breathing halo are exactly the right
idea, just monochrome. Keep the mechanism, add color.

**Becomes:** the "on" fill gradient becomes `hsl(var(--dev-hue) …)` instead of the
neutral `from-accent to-accent-press`, and the flip itself gets one `springCelebrate`
overshoot (§E) instead of `springStandard` — a switch that visibly "kicks" on, the way
a real illuminated rocker switch does, then settles:

```tsx
// switch.tsx — additive `hue?: boolean` prop
<motion.span
  className="absolute inset-0 rounded-full [opacity:var(--glow-alpha)]"
  style={{
    background: hue
      ? "linear-gradient(135deg, hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)), hsl(var(--dev-hue) var(--dev-sat) calc(var(--dev-light) - 14%)))"
      : undefined,
  }}
/>
```
The default (`hue` omitted) renders byte-identical to today — every non-device switch
(settings toggles, future generic uses) stays neutral chassis automatically.

### Top bar — CHASSIS, unchanged in kind, tightened in weight

**Today:** flat `bg-bg`, hairline bottom border, wordmark with its existing
`dot-breathe` loop. Correct already — stays chassis per §G. The one change: the
`ThemeToggle`/nav icon buttons pick up `springSnappy` (§E) on press instead of no
explicit press physics, so the one interactive chrome in the bar still feels alive
without the bar itself gaining any color.

### Status strip — CHASSIS, with one SIGNAL-SPILL accent

**Today:** flat mono footer, `StatusDot` for sidecar health. Stays flat. The one
addition: when the active-mode ledger (spec §3) reports any device in a non-`basic`
mode, a single small `Chip` — "3 lights active-modeʼd" or similar, tone `accent` —
appears at the strip's far end, using the *aggregate* palette-drift color from
whichever device the user most recently touched, not a running average (same honesty
rule as §C). Purely informational; no motion.

### Color swatches / picker — SIGNAL-PRIME candidates, currently the *only* place
color already lives correctly

**Today:** `SwatchRow`'s 10 curated colors are exactly right — real, saturated,
content-is-color per the old spec's own rule. Keep verbatim. **Change:** the active
swatch's ring (`ring-2 ring-accent`) becomes `ring-[3px]` in the swatch's *own* color
via `color-mix()` rather than the neutral accent ring, so picking a color visibly
"claims" that swatch instead of wrapping it in a generic white outline — a small
change, but it's the difference between "this button is selected" (chassis language)
and "this is the color the lamp is now making" (signal language).

### Tabs — CHASSIS, unchanged

The spring-underline mechanism (`layoutId`-shared indicator) already does exactly what
a rig's channel-select LED strip does — reuses `springStandard`, no color, no change.
Explicitly named here as a component that **passes** the audit without modification;
see §G.

### Buttons — CHASSIS by default, SIGNAL-SPILL for the one "apply paint" / "confirm"
class of action

**Today:** three flat variants (`solid`/`ghost`/`danger`), `whileTap` scale to 0.97 on
`springStandard`. **Becomes:** press physics upgrade to `springSnappy` uniformly (a
button should feel like it has more resistance than a slider drag); a fourth variant,
`variant="signal"`, exists only for buttons that commit a device-affecting action from
inside an already-colored context (paint studio's "apply," the stage's floating
"paint N segments" button) — it inherits `var(--dev-hue)` as its fill instead of
`--accent`. Every other button (nav, settings, dialogs) stays the existing neutral
variants — chassis by default, signal only where it's committing color to a device.

### Section labels — CHASSIS, explicitly frozen

`"01 — POWER"` stays exactly as sized/colored today (10–11px, `--text-low`/`--text-mid`,
`tracking-micro`). Named in §F/§G as one of the things that must **not** get louder —
it's furniture, and furniture getting loud is how you get mush.

### Toasts — SIGNAL-SPILL, and the site of celebration moment #2

**Today:** left-edge 3px bar colored by variant (`sage`/`ember`/`accent`), otherwise
neutral panel. **Becomes:** when a toast reports a *device* action (not a system
message), the bar becomes `hsl(var(--dev-hue) …)` instead of the fixed variant color,
and on mount it does one `springCelebrate` brightness pulse (see §E, "scene
confirmed") before settling to steady — the toast literally flares once to say "this
landed," then goes quiet, which is the loud/quiet dynamic from §B applied to a single
component's own lifecycle.

### Dialogs — CHASSIS shell, SIGNAL-SPILL only if launched from a colored context

`Dialog`'s `springHeavy` entrance and flat `--raised` surface stay as-is (this is
correct restraint — a modal asking "are you sure" should never be trying to compete
for attention with the thing it's confirming). The one exception: the calibration
wizard and export dialog (owned by T13, not this document's tasks) may reasonably
inherit the originating device's `--dev-hue` on their header accent only, matching the
"signal follows the device, chassis stays neutral" split — noted here for consistency,
not something T15/T16 implement since those files belong to T13.

### Schedules timeline — CHASSIS with SIGNAL-SPILL wake bands (T14's territory, noted
for consistency only — not implemented by T15/T16)

Per spec §7's original note, the wake-ramp duration band should use `--accent-dim`
when armed. Recommend upgrading that to the target device's `--dev-hue` at low alpha
instead — a wake-ramp that's about to turn the bedroom lamp warm-white should visually
hint at *that* color, not a generic accent tint. This is a one-line change inside
T14's existing scope; flagged here so the two documents don't disagree, not claimed by
T15/T16's file lists.

---

## E. Interaction and feel

**Springs.** Keep all three existing (`springStandard` 260/26 for routine settle,
`springHeavy` 170/22 for panel/dialog entrances, `fadeFast` 150ms for exits) exactly
as-is — they're correct for what they already do. Add two, in `lib/motion.ts`:

```ts
/** Press-in physics: buttons, switch thumb, slider thumb, dial knob on touch-down.
    Crisper than springStandard — a press should feel like it has more resistance
    than a value settling. */
export const springSnappy: Transition = { type: "spring", stiffness: 500, damping: 30 };

/** The two celebration moments only (§E) — visibly overshoots once before settling,
    like a VU needle kicking. Never used for routine state changes. */
export const springCelebrate: Transition = { type: "spring", stiffness: 260, damping: 12 };
```

**Press/release physics.** Every primitive's `whileTap` moves from `springStandard` to
`springSnappy` — press-down should feel immediate and slightly resistant; release
still eases out on `springStandard` so it doesn't feel twitchy. Guard: wrap the scale
transform in a `useReducedMotion()` check (currently `Button`'s `whileTap` doesn't
check this at all — a gap this document flags for T15 to close) so reduced-motion
users get an instant state change with no scale.

**Sent vs. confirmed.** The intent ledger already gives every mutating control a
12s-hold optimistic state (spec §3/§4.3) and `Switch`'s `pending` prop already shows a
breathing ring while unconfirmed. Extend that ring treatment to the slider thumb and
dial knob (currently only `Switch` has it). The **moment of confirmation** — the
polled state catching up to the optimistic one — gets a distinct, brief `springCelebrate`
pulse: the control's `--dev-alpha`-driven glow spikes to 1.3× peak for ~180ms then
settles to its steady value. This is the "the cloud caught up" tell that v2 has no
equivalent of at all — right now a confirmed command is silently indistinguishable
from an unconfirmed one once the ring stops breathing.

**Drag on the slider.** Already covered in §D — thumb and fill tint to the device
color only while actively dragging, reverting to neutral chassis when released and
idle (so a settled brightness slider doesn't sit there glowing all the time — that
would violate §B's "quiet when not actively signaling" tier discipline).

**Route transitions, dashboard ↔ device console.** This codebase already uses the
View Transitions API for the theme toggle (`globals.css`'s `::view-transition-old/new`
rules). Reuse the exact same mechanism for "opening" a device: give the mini stage on
the dashboard card and the hero stage on the console page the same
`view-transition-name: stage-${ref}` (set via inline style, only while the transition
is in flight), and wrap the `Link`'s navigation in `document.startViewTransition()`
when the API is available and `!prefersReducedMotion`. The card's instrument visually
*grows* into the console's hero instrument — no shared React tree needed, no new
dependency, and it degrades automatically to a plain instant navigation when the API
or the user's motion preference says no.

**List entrance stagger.** `staggerParent`/`panelIn` stay as-is (0.07s stagger, spring
settle) — this already reads correctly as "the board powering up" *because* `useWarmth`
already replays the filament ignite on mount for any device that's on. No change
needed; noted here so it isn't accidentally "fixed" by a future pass that doesn't
realize it's already doing the right thing.

**Celebration moment #1 — "first light."** When a device flips off→on (not on
mount, not on brightness change — specifically the off→on power transition), fire a
one-shot particle burst on the `DeviceStage`'s own Canvas2D layer: 6–10 small bright
sparks radiating from the instrument's core, `globalCompositeOperation: "screen"`,
decaying over ~400ms. This is a single imperative draw call sequence, not a persistent
loop — it does not add a second `requestAnimationFrame` subscriber to the motion
engine's driver (spec §4.1's budget stays intact); it's scheduled via one `setTimeout`-
stepped sequence or piggybacks the existing driver's tick for its ~400ms lifetime and
unsubscribes itself. Reduced motion: skip the burst, do one instant brightness flash
on the core instead (a single opacity keyframe already legal under the global
transition-duration override).

**Celebration moment #2 — "scene confirmed."** Covered under Toasts (§D) and "sent
vs. confirmed" above — when a scene/DIY/effect application's ledger entry flips from
`assumed`→`confirmed` (or an optimistic apply resolves), the toast reporting it uses
the device's hue for its bar and does the `springCelebrate` flare; if the originating
device's card is visible on the same page, it gets a single matching ring-pulse around
its `.dev-bleed` border so a dashboard-initiated action visibly "arrives" back where
it was sent from. Reduced motion: the toast bar still recolors (a color property, not
motion) but skips the pulse animation; the card border does one instant color-mix step
instead of a ringed pulse.

---

## F. Typography and layout

**What survives:** the mono-micro-label system (`SectionLabel`'s `"01 — TITLE"`
pattern, uppercase, `tracking-micro`, `--text-low`/`--text-mid`) is correct chassis
furniture and stays exactly the size it is today — 10–11px. It is explicitly *not*
part of what gets louder (§G).

**What gets bigger:** the thing that changes is what the labels are *labeling*. Every
live readout — brightness %, Kelvin, hex — currently renders at 10–11px `font-mono`,
the same visual weight as the caption next to it. That's backwards: the number that
says what the light is doing *right now* should read like an instrument-cluster
digit, not a footnote.

**Type scale:**

| Role | Today | Becomes | Notes |
|---|---|---|---|
| Console/device page title | 18–20px (`text-lg`/`text-xl`), weight 500–600 | 26–28px, weight 600, `tracking-[-0.02em]` | Archivo, unchanged family |
| Card device name (plate) | 13px medium | 15px medium | small bump, still scannable at arm's length |
| **Live readout digits** (brightness %, Kelvin, hex swatch label) | 10–11px `font-mono` | **20–22px `font-mono`, `tabular-nums`** | the single biggest change — `Odometer` gains a `size="lg"` prop, default unchanged |
| Section micro-labels | 10–11px uppercase, `tracking-micro` | **unchanged** | frozen per §G |
| Body/paragraph | 13px | unchanged | |
| Chips/mono tags | 10px | unchanged | |

**Mobile layout.** The screenshots show a plain vertical stack of cards where the live
instrument is a small garnish above a stack of generic controls (`IMG_1019.PNG`:
roughly 15% of card height is the actual light render). The fix isn't a new layout
paradigm (still a single-column stack on phone — that's the right call for one-handed
use at night) — it's giving the instrument the space it should already have:

- Instrument container sized by `aspect-ratio` (4:3 default, 16:10 on ≥`sm`) instead
  of the current fixed `h-28` (112px) — each geometry (orb/bars/matrix) gets
  proportional space instead of all three being crushed into one generic box.
- The quick-swatch + temp-preset controls move from a two-row wrap into the single
  horizontal-scroll "channel strip" dock described in §D — recovers the vertical space
  the old wrap was spending on inter-row padding and puts it back into the instrument.
- Card header (`StatusDot` + name + model chip + switch) tightens its vertical padding
  slightly — it's chassis, it doesn't need the breathing room the instrument does.
- Grid stays single-column on mobile (`sm:grid-cols-2` already correct for tablet/
  desktop) — no carousel, no swipe paradigm change; the win is entirely "each card is
  now mostly light, not mostly gray."

---

## G. What must NOT change, and why

A visual direction that says "everything gets louder" is a failed one — this section
is the honest accounting of what stays exactly as restrained as it is today, because
that restraint is the only thing that lets §B's tiers 1–3 read as loud *by contrast*.

- **Chassis stays chassis, unconditionally.** Top bar, nav rail, status strip, section
  labels, hairlines, panel borders in their idle (non-`dev-bleed`) state, body copy,
  page background — zero new color tokens applied to any of these, zero new looping
  animation beyond the two that already exist (wordmark `dot-breathe`, idle `Breath`).
  If a future task is tempted to tint the top bar because "it would look cool," that's
  the rule this section exists to block.
- **Section micro-labels are frozen at their current size and weight.** They are
  furniture. The moment "01 — POWER" competes visually with the number it's labeling,
  the reader loses the thing that told them where to look first.
- **Celebration is rationed to exactly two named moments** (§E), not a general
  "everything pulses on interaction" policy. A burst that fires on every routine
  brightness drag stops being a celebration within about three uses — it's just
  noise, and it's the fastest way to make the loud tier stop meaning anything.
  Celebrations are reserved for state *transitions* (off→on, unconfirmed→confirmed),
  never for continuous/repeated interaction.
- **The motion budget is not renegotiated.** One shared `requestAnimationFrame`
  ticker for the whole app (spec §4.1) remains the only per-frame JS loop; every
  chrome effect in this document — card bleed, thumb tint, switch fill, toast
  flare — is either a plain CSS `transition` on an `@property`-registered custom
  property or a `motion/react` spring driven by discrete state changes, never a
  second per-frame subscriber. This is why §C spent as long as it did justifying the
  update mechanism instead of just saying "add a glow."
- **Off is the calmest state on the page, always.** `--dev-alpha: 0` is not a style
  choice, it's the thing that makes "on" mean something. An off device's card must be
  indistinguishable from a plain `Panel` with no `bleed` — no residual tint, no
  ghosting, no "still kind of glowing" compromise.
- **Contrast is verified, not assumed.** Every bleed-mix percentage in §C is a
  starting number, explicitly called out as needing a real contrast check against the
  worst-case device color (§H's verify steps), not a value trusted because the math
  looks conservative on paper.

---

---

## 8. Work breakdown

16 tasks. No two tasks own the same file — verified by the file lists below; where a
file would naturally be touched by two concerns (e.g. `effects.py` needed by both ledger
writes and new studio endpoints), the ledger hook was relocated to `playback.py` instead
specifically to keep `effects.py` single-owned by the studio track. Tasks are listed in
an order that satisfies dependencies (a task never depends on a task listed after it).
`depends_on` lists task ids whose contracts (types, endpoints, function signatures) the
task needs — tasks without a shared dependency can run fully in parallel.

---

**T01 — Active-mode ledger core**
Files: `govee_cli/ledger.py` (NEW), `tests/test_ledger.py` (NEW)
Depends on: none
Done when: `govee_cli/ledger.py` implements `record_mode`, `read_all`, `read_one`,
`clear_mode`, `ActiveModeEntry`, `LEDGER_PATH`/`LEDGER_LOCK_PATH` exactly per §3.2,
including the flock + atomic-replace write algorithm and the never-raise contract.
Verify: `pytest tests/test_ledger.py -v` covers — write-then-read round trip; concurrent
writers from two threads/processes don't corrupt the file (spawn N writers, assert final
file is valid JSON with all N keys or the last-writer's value, never truncated); a
missing file, an empty file, and a corrupt-JSON file all produce `read_all() == {}`
without raising; `record_mode` swallows a simulated `OSError` (e.g. read-only
`LEDGER_PATH.parent`) without raising. `mypy govee_cli/ledger.py` clean.

**T02 — ModelSpec matrix geometry fields**
Files: `govee_cli/transport.py` (MODIFIED), `tests/test_transport.py` (MODIFIED)
Depends on: none
Done when: `ModelSpec` gains `matrix_rows`, `matrix_cols`, `matrix_wrap_col` (defaults
`0, 0, False`); H6022 spec sets `11, 12, True`; H6056 spec sets `2, 48, False`; H6008/
H6183 stay at defaults.
Verify: `pytest tests/test_transport.py -v`; `mypy govee_cli/transport.py`; `ruff check
govee_cli/transport.py`.

**T03 — CLI ledger write-through**
Files: `govee_cli/commands/power.py`, `brightness.py`, `color.py`, `temp.py`,
`scene.py`, `diy.py`, `music.py`, `snapshot.py`, `segments.py`, `daemon.py` (all
MODIFIED)
Depends on: T01
Done when: every write site listed in §3.3's CLI section calls `ledger.record_mode()`
exactly as specified — `brightness.py` calls it **not at all**; `power.py` distinguishes
off vs bare-on; `color.py`/`temp.py` always overwrite to `mode="basic"`; `music.py`
resolves the mode to its per-model name before writing `label` (never the raw int);
`segments.py` writes exactly one entry per invocation even when it makes two client
calls; `daemon.py` writes with `source="schedule"`.
Verify: `pytest tests/` (existing CLI command tests must stay green — add one new
assertion per modified command file checking `ledger.read_one(device_id)` after a
mocked successful command); `mypy govee_cli`; `ruff check govee_cli/commands`.

**T04 — wake-ramp JSON status**
Files: `/home/chumby/.local/bin/wake-ramp` (MODIFIED)
Depends on: none
Done when: `wake-ramp status --json` emits exactly the shape in §6.2 via `printf` (no
`jq`); existing `run`/`arm`/`disarm`/plain `status` (no flag) output and behavior are
byte-for-byte unchanged.
Verify: `wake-ramp status --json | python3 -m json.tool` parses without error on the real
host; `wake-ramp status` (no flag) output diffed against a pre-change capture shows no
change; `wake-ramp run` still executes correctly against the real Light Bars device (see
§9).

**T05 — Sidecar ledger integration (read-merge + basic-control write)**
Files: `webui/api/deps.py`, `webui/api/routers/devices.py`, `webui/api/mock.py`
(MODIFIED)
Depends on: T01, T02
Done when: `deps.py` implements `overlay_active_mode()` per §3.6's 5-rule merge, wired
into `read_state()` right after `apply_echo()`; `normalize_state()`'s output gains
`active`; `capabilities_block()` gains `matrix_rows`/`matrix_cols`/`matrix_wrap_col`;
`devices.py`'s `_basic_control` calls `ledger.record_mode()` alongside the existing
`record_write`; `DELETE /devices/{ref}/active-mode` exists and calls `ledger.clear_mode`;
`mock.py`'s `install()` redirects `ledger.LEDGER_PATH`/`LEDGER_LOCK_PATH` into the seeded
temp dir.
Verify: `pytest webui/api/tests/` (add cases for all 5 merge rules — online:false,
power:false, non-basic mode returns ledger verbatim, basic-mode-match→confirmed,
basic-mode-diverge→external, no-entry→unknown); manual: `GOVEE_WEBUI_MOCK=1` sidecar run,
`curl -X DELETE localhost:6057/api/v1/devices/{ref}/active-mode` returns 204; `mypy
webui/api`.

**T06 — Sidecar scene/diy/music/snapshot/segments ledger writes**
Files: `webui/api/routers/scenes.py` (MODIFIED)
Depends on: T01
Done when: `apply_scene`, `apply_diy`, `apply_snapshot`, `apply_music`, `apply_segments`
each call `ledger.record_mode()` after their existing `invalidate_state()` call, using
the same mode-selection rules as the corresponding CLI command in T03.
Verify: `pytest webui/api/tests/test_scenes.py` (mock mode) — each of the 5 mutating
routes results in a ledger entry with the correct `mode`/`label`; `mypy webui/api`.

**T07 — Playback ledger integration + group broadcast ledger write**
Files: `webui/api/playback.py`, `webui/api/routers/groups.py` (MODIFIED)
Depends on: T01
Done when: `PlaybackManager.start_ble`/`start_cloud`/`start_mock` call
`ledger.record_mode(mode="effect", ...)` on start; the natural-finish callback path
downgrades to `mode="basic"` with the last frame's color (per §3.5's table — a
user-initiated stop does **not** trigger this downgrade); `groups.py`'s
`run_group_command` calls `ledger.record_mode(source="group")` for each successfully
reached member.
Verify: `pytest webui/api/tests/test_playback.py` (mock engine) — starting an effect
writes `mode=effect`; letting a short non-looping mock effect run to completion results
in `mode=basic`; calling `DELETE /effects/playing/{ref}` mid-playback leaves `mode=effect`
unchanged; `mypy webui/api`.

**T08 — Schedule truth backend**
Files: `webui/api/external_schedule.py` (NEW), `webui/api/routers/schedules.py`
(MODIFIED), `webui/api/scheduler_runner.py` (MODIFIED)
Depends on: T04
Done when: `external_schedule.py` implements every function in §6.2's pipeline exactly;
`GET /schedules/external` returns the shape in §6.2, cached 30-60s in the existing
`TTLCache`; `POST /schedules/external/wake-ramp/{arm,disarm}` shell out verbatim and
return a fresh entry; `scheduler_runner.py` tracks `last_cycle_at`/`last_fire` and exposes
`snapshot()` per §6.5, wired into the health route's `scheduler.native` object.
Verify: `pytest webui/api/tests/test_external_schedule.py` — a fixture crontab with the
real wake-ramp line plus unrelated jobs (quartz-build, candle-warmer, morning-briefing,
etc.) filters to exactly one `wake-ramp`-kind entry and zero generic-cron entries; a
simulated unreadable-crontab (mock `subprocess.run` raising) produces
`readable:false` with a non-empty `error`, never an empty `entries` list presented as
success; a malformed cron expression in a fixture line produces `next_fire_confidence:
"unknown"`, not a crash. Manual, against the real host: `curl localhost:6057/api/v1/
schedules/external | python3 -m json.tool` — confirm it lists exactly the real wake-ramp
line and filters out the other 6 real crontab entries. `mypy webui/api`.

**T09 — Matrix studio backend**
Files: `webui/api/routers/effects.py` (MODIFIED: add `GET /effects/{file}`, `POST
/effects`), `webui/api/routers/calibration.py` (NEW), `webui/api/schemas.py`
(MODIFIED: `EffectCreateRequest`, `SegmentCalibrationRequest`), `govee_cli/config.py`
(MODIFIED: `segment_calibration` field on `DeviceConfig`)
Depends on: T02
Done when: `GET /effects/{file}` returns the full keyframe body of an existing
`scenes/*.json` file (404 if not found); `POST /effects` validates the body through
`Effect.from_dict` and rejects (422, matching the existing error envelope shape) anything
that fails segment-bounds checking against the target device's `spec.segment_count`/
`ble_segment_count`, writing accepted effects to `scenes/<slug>.json`;
`GET`/`PUT /devices/{ref}/segment-calibration` round-trip through `DeviceConfig
.segment_calibration` exactly per §5.3's JSON shape.
Verify: `pytest webui/api/tests/test_effects.py test_calibration.py` — round-trip
create→get on a fresh effect file; a malformed effect body (missing `segments`, or a
segment id exceeding the device's bound) is rejected with the same validator the CLI
uses, not a separate/looser check; calibration PUT then GET returns the exact saved
array. `mypy webui/api govee_cli`.

**T10 — Typed API client & query layer**
Files: `webui/app/src/lib/api.ts`, `webui/app/src/lib/intent.ts`,
`webui/app/src/lib/queries.ts` (MODIFIED)
Depends on: T05, T06, T07, T08, T09
Done when: `api.ts` gains the `ActiveMode` type, `DeviceState.active`, and typed client
methods for every new/modified endpoint from T05–T09 (delete active-mode, effect
create/get, segment calibration get/put, external schedules, wake-ramp arm/disarm);
`intent.ts`'s `IntentField` union gains `"active_mode"` with the existing 12s
`HOLD_MS` pattern; `queries.ts` gains hooks: `useDeleteActiveMode`, `useCreateEffect`,
`useSegmentCalibration`, `useExternalSchedules`, `useWakeRampArm`/`useWakeRampDisarm`.
Verify: `npm run typecheck` in `webui/app`; `npm run lint`; existing query hooks
(`useDeviceState`, `useOptimisticDeviceMutation`, etc.) unmodified in behavior — run
`npm run build` to confirm no downstream consumer breaks on the `DeviceState` shape
change (every existing destructure of `DeviceState` must still compile since `active` is
additive, not a rename).

**T11 — Motion engine**
Files: `webui/app/src/lib/motion-engine/types.ts`, `palette.ts`, `classify.ts`,
`driver.ts`, `canvas-renderer.ts`, `geometry.ts`, `effect-playback.ts`,
`use-motion-stage.ts`, `MotionCanvas.tsx` (all NEW)
Depends on: T10
Done when: every interface in §4.4 is implemented; `classify.ts`'s 4-layer resolver
implements §4.5 exactly, including the layer-1.5 color-word override; the override table
contains **all 8** rows from §4.6's table with the exact archetype/palette/periodSec
values given (not re-derived — the hash values in §4.6 are the acceptance values);
`driver.ts` is a single module-level singleton ticker; `use-motion-stage.ts` never
subscribes when `useReducedMotion()` is true.
Verify: unit tests (new `motion-engine/*.test.ts` files, colocated) — `classify.ts`
against all 8 named cases from §4.6 asserts exact archetype+palette match; the layer-4
hash function is tested against the literal `O Pai`/`Dark-soho`/`New effect`/
`madisonnnn`/`FRoesy2k` inputs and their specified bucket outputs; a name not in the
override table and matching no keyword resolves via layer 4, never layer 1/2. `npm run
typecheck`; `npm test` (or project's configured test runner) on the new files.

**T12 — Stage integration**
Files: `webui/app/src/components/stage/stage.tsx` (MODIFIED)
Depends on: T10, T11
Done when: `useActiveHsl` checks `active.mode` first — non-`basic`/`off` mounts
`MotionCanvas` with the classified `MotionSpec` and renders the label/confidence/age
caption instead of a guessed static color; `basic`/`off`/no-`active` path is byte-for-byte
unchanged from today's rendering (verified by visual diff or snapshot test); `MatrixLattice`
is promoted to accept real per-cell color data (still renders its existing decorative
form when no paint-studio data is present — this task does not require wiring it to the
studio, only making it *capable* of taking real data, since T13 is the consumer). The
"not what I see" reset control calls the `useDeleteActiveMode` hook from T10.
Verify: `npm run typecheck`; manual, `GOVEE_WEBUI_MOCK=1` run — a mock device with
`active.mode="diy", label="sleep"` visibly renders the blob motion with the correct
caption; a mock device with no `active` field or `mode="basic"` renders identically to
the pre-T12 build (screenshot compare against a pre-change capture).

**T13 — Matrix Paint Studio frontend**
Files: `webui/app/src/app/device/[ref]/paint-studio/paint-studio-panel.tsx`,
`canvas-grid.tsx`, `use-paint-canvas.ts`, `tools/flood-fill.ts`, `tools/gradient-tool.ts`,
`tools/symmetry.ts`, `tools/eyedropper.ts`, `palette-bar.tsx`, `device-geometry.ts`,
`dual-preview.tsx`, `motion-controls.tsx`, `calibration-wizard.tsx`, `export-dialog.tsx`
(all NEW); `webui/app/src/app/device/[ref]/control-deck.tsx` (MODIFIED); `webui/app/src/
app/device/[ref]/segments-panel.tsx` (DELETED)
Depends on: T10, T09
Done when: `control-deck.tsx`'s tab dispatch shows "Paint Studio" instead of "Segments"
when `capabilities.matrix_rows > 0`, and the old `SegmentsPanel` import/route is removed
entirely; `device-geometry.ts` implements `downsampleFrame()` exactly per §5.2's pseudocode
including gamma-correct averaging; the calibration banner (§5.3) renders whenever
`segment-calibration` GET returns `calibrated: false`; touch gesture handling matches
§5.7 exactly (drag/tap/long-press, one undo entry per stroke, `touch-action: none` scoped
to the grid only); "Preview on device" is throttled to ≤1 req/s client-side and never
fires on every pointermove; "Save as effect" performs zero device I/O.
Verify: `npm run typecheck`; unit tests for `device-geometry.ts`'s `downsampleFrame`
(feed a known 132-cell canvas, assert the 15-segment gamma-correct output against a
hand-computed expected array) and each `tools/*.ts` pure function; manual — against
`GOVEE_WEBUI_MOCK=1`, draw a pattern, export an effect, confirm `GET /effects/{file}`
round-trips the exact expected keyframe count (verify the emit-only-on-change dedup
actually reduces frame count vs. a naive per-frame emit).

**T14 — Schedules v3 (native+external+timeline+scheduler health)**
Files: `webui/app/src/app/schedules/page.tsx` (MODIFIED), `webui/app/src/app/schedules/
timeline.tsx` (NEW), `webui/app/src/app/schedules/external-panel.tsx` (NEW),
`webui/app/src/components/shell/status-strip.tsx` (MODIFIED), `webui/app/src/app/
settings/connection-section.tsx` (MODIFIED)
Depends on: T10, T08
Done when: `page.tsx` renders "Native Rules" and "External Automation" as two distinct
`Panel`s per §6.3, including the three crontab-state banners (unreadable / readable-empty
/ has-entries); `timeline.tsx` renders per §6.4 including the wake-ramp duration band and
the hatched-unknown fallback; `status-strip.tsx` and `connection-section.tsx` consume the
restructured `Health.scheduler` object from T08 with no remaining reference to the old
flat boolean.
Verify: `npm run typecheck`; `npm run build`; manual against the real sidecar (not
mock) — `GET /api/v1/schedules/external` reflects the real crontab (one wake-ramp entry,
armed/unarmed state matches the live filesystem check already done in ground truth: not
armed, so weekends show "will NOT run"); clicking Arm and re-checking
`~/.config/wake-ramp/armed` shows the file was actually created by the real script (not
faked client-side).

---

Formatted to match §8's existing task entries. Neither task owns a file already
claimed by T01–T14 — cross-checked against every file list in §8. T15 is the
design-system layer (tokens, primitives, motion constants); T16 consumes it to
rebuild the dashboard and shell. T15 has no dependency on the backend ledger work
(T01–T09) — it's a pure frontend-library pass, additive and inert until something
opts in, so it can run in parallel with the entire ledger/motion-engine track. T16
depends only on T15.

---

**T15 — Design system: Chassis/Signal token and primitive layer**
Files: `webui/app/src/styles/tokens.css` (MODIFIED), `webui/app/src/styles/globals.css`
(MODIFIED), `webui/app/src/lib/motion.ts` (MODIFIED), `webui/app/src/lib/device-bleed.ts`
(NEW), `webui/app/src/components/ui/panel.tsx` (MODIFIED), `webui/app/src/components/
ui/button.tsx` (MODIFIED), `webui/app/src/components/ui/slider.tsx` (MODIFIED),
`webui/app/src/components/ui/dial.tsx` (MODIFIED), `webui/app/src/components/ui/
switch.tsx` (MODIFIED), `webui/app/src/components/ui/chip.tsx` (MODIFIED),
`webui/app/src/components/ui/odometer.tsx` (MODIFIED), `webui/app/src/components/ui/
toaster.tsx` (MODIFIED), `webui/app/src/components/ui/section-label.tsx` (MODIFIED),
`webui/app/src/components/ui/index.ts` (MODIFIED)
Depends on: none
Done when: `tokens.css` registers `--dev-hue`/`--dev-sat`/`--dev-light`/`--dev-alpha`
via `@property` exactly per §C (syntax, `inherits: true`, initial values matching the
off/chassis state); `--glow-radius` is repurposed as the shared ambient-shadow blur
channel with a doc comment explaining the reuse; `--glow-hue`/`--glow-scale` are left
untouched and still unused; `globals.css` adds the `.dev-bleed` rule set from §C
(including the light-theme override) and the `springSnappy`-guarded reduced-motion
behavior described in §E; `lib/motion.ts` exports `springSnappy` (500/30) and
`springCelebrate` (260/12) alongside the three existing springs, unchanged; `lib/
device-bleed.ts` exports `useDeviceBleed(cardRef, hsl, power, brightness)` matching
§C's mechanism (imperative custom-property writes via `useMotionValueEvent`, no React
state churn per frame); `Panel` gains an additive `bleed?: boolean` prop (default
`false`); `Button`/`Slider`/`Dial`/`Switch` gain additive `tint`/`hue` props (default
`false`/`undefined`) that opt into `var(--dev-hue)`-driven styling per §D, with every
prop omitted producing pixel-identical output to today; `Button`'s `whileTap` (and
every other primitive's press transform) is guarded by `useReducedMotion()`, closing
the gap noted in §E; `Odometer` gains a `size="lg"` variant per §F's type scale,
default unchanged; `index.ts` re-exports any new types.
Verify: `npm run typecheck`; `npm run lint`; `npm run build` (passing is itself the
regression proof, since every new prop is additive/optional and no existing `<Button`/
`<Slider`/`<Dial`/`<Switch`/`<Panel`/`<Odometer` call site in the current tree passes
the new props); manual — `GOVEE_WEBUI_MOCK=1 npm run dev`, load the existing
(not-yet-updated-by-T16) dashboard and device console pages, confirm zero visual
change versus a pre-T15 screenshot, since none of these files are wired into any page
yet.

---

**T16 — Dashboard and shell composition**
Files: `webui/app/src/app/page.tsx` (MODIFIED), `webui/app/src/components/shell/
top-bar.tsx` (MODIFIED), `webui/app/src/components/shell/status-strip.tsx` (MODIFIED),
`webui/app/src/components/device/device-plate.tsx` (NEW, extracted from `page.tsx`),
`webui/app/src/components/device/groups-section.tsx` (NEW, extracted from `page.tsx`)
Depends on: T15
Done when: `DevicePlate` and the groups broadcast UI are extracted out of `page.tsx`
into the two new files and consume `useDeviceBleed` + `Panel`'s `bleed` prop so every
dashboard card tints its background/border/ambient shadow to the live device color per
§C, degrading to flat chassis when off/offline; the plate's instrument container uses
`aspect-ratio` sizing per §F instead of the fixed `h-28`; the quick-swatch + temp-preset
row becomes the horizontal-scroll channel-strip dock from §D; the brightness slider and
power switch on the plate use the new `tint`/`hue` props; `top-bar.tsx`'s icon buttons
pick up `springSnappy` press physics while its border/background/breadcrumb typography
stay on the exact unmodified chassis tokens (`--bg`/`--hairline`/`--text-low`/
`--text-mid`) per §G; `status-strip.tsx` gains the optional active-mode aggregate `Chip`
described in §D with no other visual change; the "first light" and "scene confirmed"
celebration moments from §E are wired to real power-toggle and ledger-confirmation
events on the dashboard grid; the stage-promotion View Transition from §E fires when
navigating from a card to its device console and gracefully no-ops under
`prefers-reduced-motion` or an unsupporting browser.
Verify: `npm run typecheck`; `npm run lint`; `npm run build`; manual with
`GOVEE_WEBUI_MOCK=1 npm run dev` — load the dashboard with the mock fleet (≥3 devices
with distinct colors) and confirm each card visibly tints toward its own device's
color with no cross-card bleed (i.e. `--dev-hue` does not leak past a card's own
`Panel` boundary — inspect two adjacent cards' computed styles in DevTools and confirm
they differ); toggle a mock device off and confirm its card's `.dev-bleed` background/
border/shadow return to the flat chassis baseline within one `--dur-slow` transition,
with no residual tint; using DevTools' contrast checker (or `npx @axe-core/cli` against
the running dev server if available), confirm `--text-hi` against a card's tinted
background at `--dev-alpha: 1` and the lightest mock device color (`#EAF2FF`) stays
≥4.5:1 in both themes; toggle a device off→on and confirm the one-shot particle burst
fires exactly once (not on every re-render/poll tick).

---

## 9. Verification plan

### 9.1 Must stay green throughout (run after every task, not just at the end)

```bash
cd /home/chumby/projects/govee-cli
source .venv/bin/activate      # or python3 -m venv .venv && pip install -e ".[dev]" if missing
pytest
mypy govee_cli
mypy webui/api
ruff check govee_cli webui/api

cd webui/app
npm run typecheck
npm run lint
npm run build
```

None of these may regress at any point in the work breakdown — a task is not "done" if
it turns any of these red, even transiently, per the project's own verification-before-
completion discipline.

### 9.2 End-to-end verification against the real devices in ground truth

Do this only after T01–T14 are individually verified per §8's per-task checks. Use
`govee-cli info --device <name>` first for each device (read-only, prints transport +
capabilities) before any mutating command, per the project's existing testing sequence
convention in CLAUDE.md.

**Ledger (§3) — against the Shelf Lamp (H6022, `50:CE:E8:6E:80:C6:50:3F`)**:
1. `govee-cli diy sleep --device "Shelf Lamp"` (or the console's DIY tab).
2. Confirm `~/.config/govee-cli/active-mode.json` contains a `diy`/`sleep` entry for that
   device id within a few seconds.
3. `curl http://127.0.0.1:6057/api/v1/devices/{ref}/state | python3 -m json.tool` — confirm
   `active.mode == "diy"`, `active.label == "sleep"`, `active.confidence == "assumed"`.
4. Open the console's device page for Shelf Lamp — confirm the stage shows the blob
   motion (not a static warm-white render) and the caption reads "sleep — DIY scene,
   assumed, {age}".
5. Visually compare the rendered blob's blue↔magenta palette against the physical lamp
   in the room — this is the one step that can only be judged by eye; per the project's
   "Luke can't be the oracle, verify programmatically where possible" convention, treat
   this as the one deliberately manual check and flag any washed-out/cyan-tinted result
   (§4.8's known risk) rather than asserting it's correct from code alone.
6. `govee-cli color FF8800 --device "Shelf Lamp"` — confirm the ledger entry flips to
   `mode: basic` and the console stage returns to a static-color render.
7. `curl -X DELETE http://127.0.0.1:6057/api/v1/devices/{ref}/active-mode` — confirm
   `204`, ledger entry for that device is gone, `active.mode == "unknown"` on next read.

**Ledger — against Light Bars (H6056, `6D:19:DD:6E:86:46:44:0C`)**: repeat step 1-3
with a firmware scene (`govee-cli scene <name>`) and a music mode (`govee-cli music
<mode>`), confirming `mode: scene`/`mode: music` and that the resolved `label` is the
mode **name**, not the raw integer — this is the direct regression check for the
cross-model music-integer hazard in §4.7.

**Schedule truth (§6) — against the real host**:
1. `wake-ramp status --json | python3 -m json.tool` — confirm valid JSON, `armed_date:
   null` (live-confirmed not armed as of ground truth capture).
2. `curl http://127.0.0.1:6057/api/v1/schedules/external | python3 -m json.tool` —
   confirm exactly one entry, `kind: "wake-ramp"`, `next_fire_confidence: "exact"`,
   `wake_ramp_status.today_will_run` matches whatever today's actual weekday is.
3. In the console's Schedules page, confirm the other 6 real crontab entries
   (quartz-build, 4× candle-warmer, morning-briefing, evening-healthcheck,
   homeio-backup) do **not** appear anywhere in the External Automation panel.
4. Click Arm in the UI; confirm `~/.config/wake-ramp/armed` now exists with today's or
   the next weekend date; re-run `wake-ramp status` (plain) and confirm it agrees.
5. Click Disarm; confirm the flag file is removed.
6. Smoke-test `crontab -l` specifically **through the running `govee-webui-api.service`**
   (not just an interactive shell) — this is the `NoNewPrivileges` risk flagged in §6.1;
   if it fails under the service but works interactively, apply the `/var/spool/cron/
   crontabs/chumby` fallback before shipping T08/T14.

**Matrix studio (§5) — against the Shelf Lamp**:
1. Run the calibration wizard once against the real H6022; confirm the resulting
   `segment_calibration` persists in `config.json` and the "approximate mapping" banner
   disappears on subsequent loads.
2. Paint a simple pattern (e.g. one solid color, one two-tone split), export via "Preview
   on device," and visually confirm the physical lamp's segments reflect the exported
   preview to the extent the 15-segment quantization allows.
3. Save an effect with a `rotate` motion descriptor at cloud (2fps) export; play it via
   the existing Effects tab; confirm it runs without triggering `GoveeV2RateLimited`
   (i.e. the emit-only-on-change dedup from §5.6 is actually keeping request volume
   under ~2/s).
4. Confirm the CLI can independently load and play the same saved effect
   (`govee-cli effect play scenes/<slug>.json --device "Shelf Lamp"`) — proving the
   studio's output is a real, portable `Effect` file and not a studio-only format.

**Motion engine reduced-motion / battery (§4.9)**: with the OS-level "reduce motion"
setting on, confirm the console renders a single static frame per active non-basic mode
(no canvas ticker running — check via a `performance`/devtools frame-rate inspection that
no `requestAnimationFrame` callbacks fire for stage canvases) and that the existing CSS
`prefers-reduced-motion` clamp still applies to the unrelated spring/glow system
unchanged.

### 9.3 Known-unverified assumptions to re-check during T03/T05 implementation, not defer silently

Per §3.5's table and this project's own established practice of never asserting
unconfirmed hardware behavior:
- "A plain color/temp write always ends a running scene" — verify empirically per model
  (start a DIY scene, send a plain color command, confirm visually the scene actually
  stopped) before relying on it as the sole invalidation signal.
- "A brightness-only write does NOT end a running scene" — verify the opposite direction
  per model; if wrong on any model, a stale scene label will persist after the user
  actually dimmed away from it, and `brightness.py`'s "no ledger write" behavior in T03
  needs to be revisited for that specific model.

Neither of these blocks shipping T01–T14 — they are documented risks (§3's design
decision explicitly rejects fabricating a decay/confidence mechanism to paper over them)
— but they must be spot-checked against the real Shelf Lamp and Light Bars during T03's
implementation, and any model found to violate the assumption gets a per-model override
noted in `govee_cli/ledger.py` rather than a silent global behavior change.
