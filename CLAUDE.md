# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Development Commands

```bash
# Run all tests
pytest

# Run a single test file
pytest tests/test_protocol.py

# Run a single test class or function
pytest tests/test_protocol.py::TestBuildPacket::test_packet_structure

# Type check
mypy govee_cli

# Lint
ruff check govee_cli

# Auto-fix lint issues
ruff check --fix govee_cli
```

## Architecture

The stack is: **CLI → Commands → transport routing → (cloud v1 | cloud v2 | BLE) → Device**

### Transports — read this first

Three transports are in play, and which one carries a command depends on the
**model**, not the command:

| Transport | Endpoint | Used by | Reaches |
|---|---|---|---|
| `cloud-v1` | `developer-api.govee.com/v1` | H6056, H6008, H6183 | power, brightness, color, temp, state |
| `cloud-v2` | `openapi.api.govee.com/router/api/v1` | H6022 | everything above **plus** scenes, DIY scenes, segments, music |
| `ble` | direct GATT | H6056 scenes/effects/segments; anything unregistered | 0x33 packet protocol |

**The v1 API does not list every device.** The H6022 is invisible to it entirely,
which is why v2 exists in this codebase. `scan-http` therefore discovers over v2.

Routing lives in **`govee_cli/transport.py`** — one `ModelSpec` per model. Adding
a model means adding a spec there and a handler in `devices/`, not editing every
command file.

### Key layers

- **`govee_cli/cli.py`** — Click root group. Loads config on every invocation, injects `default_mac`, `default_adapter`, `default_timeout` into `ctx.obj`. All commands are registered here via `main.add_command()`.

- **`govee_cli/transport.py`** — `MODEL_SPECS` (segment count, temp range, per-model cloud feature flags) and `resolve_target()`. The single source of truth for which transport reaches which model.

- **`govee_cli/http_v2.py`** — Govee Open API v2 client. Capability-based (`{type, instance, value}`), retries with backoff on 429/5xx, caches the firmware scene library on disk for 7 days.

- **`govee_cli/http.py`** — Legacy v1 client. Still the path for H6056/H6008/H6183; do not migrate them without re-verifying against hardware.

- **`govee_cli/config.py`** — Config dataclass backed by `~/.config/govee-cli/config.json`. Holds default MAC, adapter, timeout, brightness, color, and device groups (`{group_name: [mac, ...]}`).

- **`govee_cli/commands/`** — One file per command. Each exports a `command` (or group) object that gets registered in `cli.py`. Commands pull `default_mac` from `ctx.obj` and accept `--device` to override.

- **`govee_cli/commands/_common.py`** — `resolve()` turns `--device` into a `Target` (device id + model + transport); `parse_segments()` handles `all` / `0,3` / `2-6`; `require_v2()` produces the "this model can't do that" error.

- **`govee_cli/ble/protocol.py`** — The core protocol layer. `encode_*()` functions return `Command` objects; `build_packet(cmd)` produces the final bytes (`[0x33, cmd_type, ...payload, checksum]`). **All GATT UUIDs and packet formats are placeholders pending BLE sniffer verification.**

- **`govee_cli/ble/gatt.py`** — Wraps `bleak.BleakClient`. Connects, writes commands, reads state, subscribes to notifications.

- **`govee_cli/ble/scanner.py`** — Wraps `bleak.BleakScanner` for device discovery, filtered by Govee manufacturer prefix.

- **`govee_cli/devices/h6056.py`** — H6056-specific constants (6 segments, segment layout, scene ID map). `h6022.py` holds the 15-zone layout and that model's four music modes.

- **`govee_cli/schedule/scheduler.py`** — APScheduler-based scheduler; rules persisted in `~/.config/govee-cli/schedule.json`; runs under `govee-cli daemon`.

- **`govee_cli/scenes/`** — Built-in scene JSON files live in `scenes/` at the repo root; `effects.py` parses them; `capture.py` sniffs BLE traffic from the Govee app to build new scene files.

### bleak 3.0 API notes

- `BLEDevice.rssi` and `.metadata` are removed — RSSI/ManufacturerData now live in `device.details['props']`
- `start_notify` callback signature changed to `(char: BleakGATTCharacteristic, data: bytearray) → None`

## Device Notes (H6056)

- **Static MAC**: `D0:C9:07:FE:B6:F0` (use for config)
- **Advertised name/address**: `Govee_H6056_440C` / `DD:6E:86:46:44:0C` (random, may change)
- **GATT write characteristic**: `00010203-0405-0607-0809-0a0b0c0d2b11` (all commands go here)
- **GATT notify characteristic**: `00010203-0405-0607-0809-0a0b0c0d2b10` (responses arrive here)
- Device must be found by `govee-cli scan` first; connect by name or random address

## Device Notes (H6008 — GVH-series, BLOCKED)

- **MACs**: `5C:E7:53:69:87:FB` (Lamp Front), `5C:E7:53:63:8F:01` (Lamp Top)
- **Advertised names**: `GVH600887FB`, `GVH60088F01`
- **OUI**: `5C:E7:53` (HOMY IOT SOLUTIONS) — different chip from ihoment_ H6008
- **Status**: BLE protocol unknown. Connects fine, GATT writes accepted, bulb ignores all commands.
- **0x33 protocol does not work** on this hardware revision.
- **No WiFi available** (eduroam only, WPA2-Enterprise incompatible with IoT devices).
- **Cloud/LAN API not viable** without a WPA2-Personal network for the bulbs.
- **Unblocking requires**: nRF52840 passive BLE sniffer dongle (~$10) OR successful iOS sysdiag capture to see what the Govee app sends.
- See `docs/H6008_PROTOCOL.md` for full investigation.

## Device Notes (H6022 — RGBIC Table Lamp 2, FULLY WORKING)

- **Cloud device ID**: `50:CE:E8:6E:80:C6:50:3F` (registered as `Shelf Lamp`, group `shelf`)
- **Transport**: cloud v2 **only**. Invisible to the v1 API — a v1 code path cannot see it.
- **Working**: power, brightness, color, temp (2700–6500K), 15-segment color, 94 firmware
  scenes, DIY scenes, firmware music mode, cloud-driven keyframe effects.
- **Segments**: 0–14 addressable; index 15 → 400 `Parameter value out of range`.
  Two-tone painting confirmed on the physical lamp.
- **`segmentedBrightness` is not supported** → 400 `devices not support this instance`.
  (Useful signal: the API really does distinguish supported instances, so a 200 elsewhere means something.)
- **BLE**: no published protocol for this SKU anywhere. The 0x33 protocol is *not* confirmed
  to apply. Would need an original nRF52840 capture.
- **Do NOT enable LAN Control** for this lamp — an open upstream bug
  (wez/govee2mqtt#518) reports it makes the H6022 unresponsive even to its own
  buttons until LAN Control is turned back off.
- See `docs/H6022_PROTOCOL.md` for payload shapes and the full investigation.

### H6022 gotchas

- `diyScene` takes a **bare int**; `{"value": n}` is rejected with `Missing relevant parameters: id`.
- `lightScene` needs **both** `paramId` and `id`.
- `/device/state` returns `""` for scene/segment/music **always** — an empty value is not
  evidence of failure. Those can only be confirmed visually.
- Setting `colorTemperatureK` zeroes `colorRgb` and vice versa; they are mutually exclusive.
- Music mode integers are **model-specific**. H6022 = Rhythm 3, Rolling 4, Energic 5,
  Spectrum 6. The H6056 uses an entirely different mapping. Never share these across models.

## Protocol Status

**Confirmed working (community sources + GATT dump):**
- BLE scanning
- GATT service/characteristic UUIDs
- Packet format: `[0x33][cmd][payload padded to 18 bytes][XOR checksum]` = 20 bytes
- `power on/off` — command byte `0x01`
- `brightness` — command byte `0x04`
- `color` — command byte `0x05`, mode byte `0x02` (MODE_2, all segments)

**Unverified (best-guess, needs btmon capture):**
- `temp` — mode byte `0x05` assumed, Kelvin encoding unconfirmed
- `segments` — MODE_1501 format assumed from H6053 sibling; bitmask TBD
- `scene` — mode byte `0x04`, but scene IDs for H6056 unknown
- `parse_state` — notification response format unknown
- `music`, `effect` — command bytes unconfirmed

**To capture remaining protocol:** run `btmon` while using the official Govee app, then `govee-cli record` to save packets. Update `govee_cli/ble/protocol.py` with real values.

## Testing Sequence

Start simple, verify each step before proceeding:

```bash
source .venv/bin/activate
govee-cli config --mac D0:C9:07:FE:B6:F0   # set default device
govee-cli scan                               # confirm device visible
govee-cli power on                           # simplest test
govee-cli power off
govee-cli brightness 50
govee-cli color FF0000                       # red
govee-cli color 0000FF                       # blue
govee-cli temp 4000                          # unverified — try after color works
```

---

## Development Workflow

### Subagent-Driven Development

This project uses **subagent-driven-development** for all non-trivial changes:

1. **Task dispatch** — Each feature/fix gets its own subagent
2. **Spec compliance review** — Code reviewer verifies implementation matches requirements
3. **Code quality review** — Second review checks for issues (confidence >= 80)
4. **User validation** — User tests before moving to next task

**Critical workflow rule:** Never skip reviews. Both spec compliance AND code quality reviews are mandatory.

### Communication Protocol

**User is the authority.** When user says:
- "Use X as source of truth" → Use X, don't argue
- "Follow the systematic debugging skill" → Follow it exactly
- "Stop guessing" → Stop, investigate root cause

**Anti-patterns to avoid:**
- Ignoring user instructions to "do it my way"
- Deflecting questions instead of answering directly  
- Patronizing explanations (user knows what they're doing)
- Jumping between approaches without finishing any

### Research Methodology

**Parallel Implementation Research** for protocol reverse engineering:

1. **Check existing repos FIRST** — Look at sisiphamus/govee-controller, egold555/Govee-Reverse-Engineering, wez/govee-py
2. **Community consensus** — Check Home Assistant issues, GitHub issues
3. **Only then capture** — If existing docs insufficient, use btmon/hcidump

**The H6008 lesson:** The working implementation was already documented in sisiphamus/govee-controller. Should have looked there immediately instead of trying to capture fresh traffic.

### Debugging Discipline

**Systematic Debugging skill applies ALWAYS:**
1. Phase 1: Root cause investigation (no fixes yet)
2. Phase 2: Pattern analysis (compare working vs broken)
3. Phase 3: Single hypothesis, test minimally
4. Phase 4: Implement one fix, verify

**Red flags:**
- "Quick fix for now, investigate later"
- Multiple fixes at once
- Already tried 2+ fixes without success
- Answering "probably X" without verification

### When Tools Fail

**btmon/hcidump on Pop!_OS:**
- `btmon` 5.72 crashes immediately on startup with SIGABRT (glibc stack protector, buffer overflow in btmon itself — not a traffic volume issue). Building from source (5.75) did not fix it.
- `hcidump` works but only captures the Linux machine's own HCI traffic (`hci0`). Cannot see iPhone BLE traffic.
- **Single-connection BLE limit**: cannot passively monitor a bulb while another device (phone) is connected to it. Passive sniffing requires dedicated hardware (nRF52840 dongle).

**The GVH H6008 lesson:** The `ihoment_H6008` (OUI `98:17:3C`) protocol is documented in sisiphamus/govee-controller and works. The **GVH H6008** (OUI `5C:E7:53`, company ID `0x8843`) is a completely different hardware revision with an undocumented BLE protocol. The `0x33` protocol does not work on GVH-series devices. No community reverse engineering exists for this variant. See `docs/H6008_PROTOCOL.md` for full investigation notes.
