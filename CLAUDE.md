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

The stack is: **CLI → Commands → BLE abstraction → Protocol → Device**

### Key layers

- **`govee_cli/cli.py`** — Click root group. Loads config on every invocation, injects `default_mac`, `default_adapter`, `default_timeout` into `ctx.obj`. All commands are registered here via `main.add_command()`.

- **`govee_cli/config.py`** — Config dataclass backed by `~/.config/govee-cli/config.json`. Holds default MAC, adapter, timeout, brightness, color, and device groups (`{group_name: [mac, ...]}`).

- **`govee_cli/commands/`** — One file per command. Each exports a `command` (or group) object that gets registered in `cli.py`. Commands pull `default_mac` from `ctx.obj` and accept `--device` to override.

- **`govee_cli/ble/protocol.py`** — The core protocol layer. `encode_*()` functions return `Command` objects; `build_packet(cmd)` produces the final bytes (`[0x33, cmd_type, ...payload, checksum]`). **All GATT UUIDs and packet formats are placeholders pending BLE sniffer verification.**

- **`govee_cli/ble/gatt.py`** — Wraps `bleak.BleakClient`. Connects, writes commands, reads state, subscribes to notifications.

- **`govee_cli/ble/scanner.py`** — Wraps `bleak.BleakScanner` for device discovery, filtered by Govee manufacturer prefix.

- **`govee_cli/devices/h6056.py`** — H6056-specific constants (6 segments, segment layout, scene ID map).

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

**btmon/hcidump buffer overflow on Pop!_OS:**
- Version 5.72 has known buffer overflow with high BLE traffic
- Building from source (5.75) doesn't fix it on this system
- Alternative: Use Python + bleak for direct capture instead
- Or: Accept that capture isn't possible and use documented protocols from other repos
