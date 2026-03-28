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

## Protocol Status

**Verified:** BLE scanning, protocol encoder unit tests (all passing), CLI registration.

**Placeholders (need BLE sniffer verification):** All GATT UUIDs in `protocol.py`, all light control command byte formats, built-in scene IDs.

To reverse-engineer: capture BLE traffic from the Govee app using `btmon` + Wireshark or `govee-cli record`, then update `govee_cli/ble/protocol.py` with real UUIDs and packet formats.
