# govee-cli as the single control plane — design

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation
**Author:** Claude (with Luke)

---

## Problem

Govee automation on this machine works, but no two parts agree on how.

`govee-cli` has **no library API**. Every Click command in `govee_cli/commands/*.py` loads config
and constructs its own client inline, so there is nothing a caller can import. That single fact
caused everything downstream:

1. `govee-api` (the FastAPI service Home Assistant depends on) could not reuse the CLI, so it
   shelled out to the `govee-cli` binary — paying process-startup cost per light command and
   putting the BLE adapter lock in the wrong layer.
2. That was slow and contended, so it was rewritten to call the Govee cloud API directly.
   `govee-api/govee_client.py` (321 lines) and `govee_http_state.py` are now **dead code** still
   on disk; `main.py` imports neither.
3. There are now **two Govee protocol implementations** that have drifted apart, and they target
   **different API versions**: `govee_cli/http.py` uses cloud **v1**, `govee-api/govee_v2_client.py`
   uses cloud **v2**.

Meanwhile the surrounding state is worse than the code:

- `~/govee-api` — the service driving the lights for 41 days — **is not a git repository.**
- `/srv/homeassistant/config` — **is not a git repository.**
- `govee-api/device_registry.py` declares `"Light Bars": {"transport": "ble"}`, but `main.py`
  never reads the `transport` field. The bars have been on cloud HTTP the whole time.
- Three device registries disagree. The same lamp is `5C:E7:53:69:87:FB` (BLE) and
  `82:1F:5C:E7:53:69:87:FA` (cloud). Nothing reconciles the two identifier spaces.
- The only running automation is a `crontab` calling `candle-warmer`. `automations.yaml` and
  `scenes.yaml` in HA are both empty. `scripts/morning_lights.py` is a finished sunrise feature
  that is untracked and scheduled by nothing.
- Light presets and the H6056 operating knowledge live only in `~/.hermes/` — a system being
  decommissioned.

## Goal

Make `govee-cli` the single, trustworthy control path for every Govee device, with the FastAPI
server and the CLI as thin consumers of one core. Then move automation into Home Assistant on top
of a foundation that does not lie.

**Explicit non-goal:** cracking the GVH H6008 BLE protocol. It is hardware-blocked pending an
nRF52840 sniffer. The lamps stay on cloud HTTP.

---

## Leading hypothesis: the brightness bug

The "H6056 silently rejects brightness below 5%" rule is treated as a hardware floor in Hermes's
memory and skills. Reading the code, it is more likely a **unit-scale mismatch in the state path**:

- `govee-api` returns brightness on **Govee's 1–100 scale** (`main.py:126`, `_normalize_v2_state`).
- HA's template light `level:` field expects **0–255** (`configuration.yaml:120`).

Consequences if true:
- Set 50% → command path converts HA 128 → Govee 50 (correct) → state path returns `50` → HA reads
  it as 50/255 ≈ 20%. The slider disagrees with itself after every 30s poll.
- Set 1% → Govee 1 → HA reads `1`/255 ≈ 0 → HA treats the light as **off**. This presents exactly
  as "sub-5% silently fails".

The command path is self-consistent; only the state path is wrong. **This is a hypothesis, not a
finding.** Phase 1 reproduces it on hardware before any fix is written. If it is wrong, the
automation decision (HA vs. daemon) must be revisited, because it rests on HA being able to
address the full brightness range.

A second inherited claim — "cloud v1 silently drops `colorTemperature` on H6008" — is also
secondhand (from a Hermes skill) and load-bearing (it is why the core must speak v2). Phase 1
confirms it too.

---

## Architecture

```
govee_cli/
  core/            NEW — the single control path. No Click, no FastAPI.
    registry.py      Device: name, model, cloud_id, ble_mac, transport, caps
    transport.py     Transport protocol → BLETransport | CloudTransport
    controller.py    power / brightness / color / temperature / state
    profiles.py      named light profiles (rescued from Hermes)
  ble/             existing protocol.py, gatt.py, scanner.py — wrapped by BLETransport
  cloud/           http.py moves here; NEW v2.py client
  commands/        Click commands become thin wrappers over core
  server/          govee-api moves here; imports core in-process
  schedule/        DEPRECATED — removed in phase 5
```

### Canonical units

The core speaks **Govee's 1–100 brightness scale** internally, and `DeviceState` carries
`brightness_pct: int` (1–100). Conversion to HA's 0–255 happens **at the server edge, in both
directions**, in one place. The current bug exists precisely because conversion happens on the
command path but not the state path.

### Device registry

One `Device` model, carrying both identifier spaces:

```python
@dataclass
class Device:
    name: str                  # "Lamp Front"
    model: str                 # "H6008"
    cloud_id: str | None       # "82:1F:5C:E7:53:69:87:FA"  (Govee API device id)
    ble_mac: str | None        # "5C:E7:53:69:87:FB"
    transport: Transport       # BLE | CLOUD — the command path
    state_source: Transport    # CLOUD for all devices (see below)
    caps: DeviceCaps           # segments, min/max brightness, temp range
```

Single source of truth: `~/.config/govee-cli/config.json`, schema **v3**, with a migration from v2.
`govee-api/device_registry.py` is deleted.

### Transport policy (decided)

| Device | Model | Command transport | State source | Why |
|---|---|---|---|---|
| Light Bars | H6056 | **BLE** | Cloud | BLE is the only path to segments, DIY effects, true 1% brightness |
| Lamp Front | H6008 | Cloud v2 | Cloud | GVH BLE protocol unknown — no choice |
| Lamp Top | H6008 | Cloud v2 | Cloud | ditto |

State reads go over cloud for **all** devices. This is deliberate: bluez permits one connection per
adapter, and HA polling three devices over BLE on `hci0` is what broke the 30s poll window
previously. With state on cloud, the adapter is only ever touched by light-bar *commands*, so
contention effectively disappears.

`BLETransport` owns a **module-level `asyncio.Lock`** so bluez never sees concurrent operations on
`hci0`. The dead `govee_client.py` already implements this lock correctly; it will be lifted rather
than reinvented.

### Server

`govee_cli/server/app.py` keeps the **HTTP contract byte-identical** to today's `govee-api`:

```
GET  /api/health
GET  /api/devices
GET  /api/devices/{name}/state
POST /api/devices/{name}/power        {state: on|off}
POST /api/devices/{name}/brightness   {level: 0-255}     # HA scale, converted at the edge
POST /api/devices/{name}/color        {r,g,b} | {hex} | {h,s}
POST /api/devices/{name}/temperature  {kelvin}
GET  /api/kasa/state
POST /api/kasa/power
```

HA's `configuration.yaml` therefore needs **no changes** during the consolidation. That is the
safety property that makes the whole migration reversible. New endpoint added in phase 4:
`POST /api/profiles/{name}/apply`.

Kasa moves in as `server/kasa.py`, and its `KeyError: 'result'` (TP-Link changed their cloud
response shape) is fixed — this is why `/api/kasa/state` currently 500s and why the candle-warmer
cron's verification step fails.

### Profiles

Rescued from `~/.hermes/` (memory + `lighting-profiles` skill) into `core/profiles.py`, exposed as
`govee-cli profile apply <name>` / `profile list`, and mirrored as HA scenes.

| Profile | Lamps | Bars |
|---|---|---|
| daytime | 2702K @ 50% | 2702K @ 50% |
| nighttime | `#320166` @ 50% | 2702K @ 50% |
| sleeping | `#320166` @ 50% (hs `269.109, 99.02`) | 2702K @ **1%** |
| movie | 2200K @ 20% | 2200K @ 10% |
| focus | 5000K @ 100% | 5000K @ 100% |
| party | `#FF69B4` @ 100% | `#00FFFF` @ 100% |

Separately, `#7B2CBF` @ 50% is the "cozy purple" default for when Luke says *"make it purple"* —
a one-off color, not a profile. Exact values for `movie`, `focus`, and `party` are transcribed from
the Hermes `lighting-profiles` skill and have **not** been confirmed against hardware or against
Luke's preference; phase 4 confirms them before they ship.

Two inherited operating rules to preserve as code, not folklore:
- On H6008, **set color before brightness** — a mode switch drops a pending brightness command.
- "Sleep lights" means bars @ 1% + lamps @ 50% purple. It does **not** mean the whole bedroom.
  Never mass-off.

---

## Sequencing

| Phase | Work | Risk |
|---|---|---|
| 0 | `git init` both `~/govee-api` and `/srv/homeassistant/config`; commit current state verbatim | None — pure safety net, no behavior change |
| 1 | Reproduce the brightness-scale and v1-colortemp bugs on real hardware | None — diagnosis only, no fixes |
| 2 | Extract `core/` (registry, transport, controller); v2 cloud client; rewrite Click commands as thin wrappers | CLI behavior must not change; the 77 existing tests are the guard |
| 3 | Fold server into repo; cut systemd over; fix Kasa `KeyError` | **Live service.** Old `~/govee-api` stays until verified; HTTP contract unchanged so HA is untouched |
| 4 | Profiles: rescue Hermes presets, `profile` command, `/api/profiles/*` | Low |
| 5 | HA automations: sunrise ramp, bedtime, candle warmer. Retire the crontab, `morning_lights.py`, and `schedule/` | Changes live bedroom behavior — verify each before enabling |

Phase 0 and 1 are non-negotiable prerequisites. Nothing gets fixed before it is reproduced, and
nothing gets moved before it is under version control.

## Deletions this earns

- `govee-api/govee_client.py`, `govee_http_state.py`, `device_registry.py` — dead or superseded
- `scripts/morning_lights.py` — superseded by HA's native sun triggers
- `test_h6008.py`, `test_cli_alt.py`, `test_packets.py`, `test_script.py` — loose scratch files in repo root
- `govee_cli/schedule/` — deprecated in favour of HA
- the `candle-warmer` crontab entries

## Testing

- **Core:** unit tests against a `FakeTransport`. Existing 77 tests (47 protocol) must stay green
  throughout phase 2 — they are the regression guard proving CLI behavior did not change.
- **Cloud:** recorded/mocked HTTP responses; explicit test that brightness round-trips
  1–100 ↔ 0–255 without loss at the boundaries (1%, 5%, 100%). This is the bug class that caused
  the incident; it gets a permanent test.
- **Server:** FastAPI `TestClient` asserting the exact HTTP contract HA depends on, so it cannot
  silently drift again.
- **Hardware:** documented manual smoke sequence per phase, extended with the 1% sleep case. This
  project exists because of hardware behavior; unit tests alone do not close a phase.

## Consequences accepted

1. **Deprecating the scheduler daemon couples automation to HA.** If HA is down, the lights do not
   wake you up. Accepted because HA already has native sun triggers and a UI, and rebuilding them
   in the CLI is duplicated work.
2. **govee-cli stops being purely a CLI.** It becomes the control plane, with a CLI and an HTTP
   server as two front-ends. This is honest about what it already is.
3. **The H6056 stays on BLE** — the last genuinely cloud-free path. If BLE proves flaky, the
   fallback is cloud v2, at the cost of segments and 1% sleep brightness.

## Out of scope / follow-ups

- GVH H6008 BLE protocol (hardware-blocked; needs an nRF52840 sniffer, ~$10).
- `jarvis-skill` has no intent backend since Hermes was stopped on 2026-07-12. Retire or re-back it —
  a separate decision.
- Secrets hygiene: `KASA_EMAIL` / `KASA_PASSWORD` are inline in the systemd unit file and should move
  to a mode-600 `EnvironmentFile`. The Govee API key sits in `config.json`.
- `/srv/homeassistant/config/home-assistant.log` is 87 MB and unrotated.
- Correct the false git history: commit `722c7d2` ("Ralph loop iter 11: EXHAUSTED — GVH H6008
  protocol confirmed working (26-30/30 commands)") is wrong. The GVH BLE protocol was never cracked;
  an autonomous loop counted "GATT write accepted" as success. The lamps were unblocked by the
  cloud HTTP commit that followed, not by BLE.
