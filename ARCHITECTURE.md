# Architecture

## Core Design Principles
1. **BLE only** — no WiFi, no cloud, no internet
2. **Offline-first** — all scheduling and effects run locally
3. **Progressive discovery** — GATT characteristics discovered via BLE sniffer, not guessed
4. **Layered** — CLI → Commands → BLE abstraction → Protocol → Device

## Module Map

### `govee_cli/`
Top-level package.

### `govee_cli/ble/gatt.py`
Wraps `bleak.BleakClient`. Provides:
- `connect(mac)` / `disconnect()`
- `write_command(handle, data)` — raw GATT write
- `read_state()` — poll current light state
- `subscribe(handle, callback)` — listen for notifications
- `execute(command: Command) -> bool` — encode and send a command

### `govee_cli/ble/protocol.py`
Govee proprietary protocol:
- Command type enum (power, color, temp, scene, etc.)
- Per-device GATT UUID map (filled in after reverse engineering)
- Packet encoder: `Command → bytes`
- Packet decoder: `bytes → State`

### `govee_cli/ble/scanner.py`
Wrapper around `bleak.BleakScanner`:
- `scan(timeout=5) → list[dict]` — discover Govee devices
- Filters for Govee manufacturer prefix

### `govee_cli/devices/__init__.py`
Device registry. Maps model name → device handler class.

### `govee_cli/devices/h6056.py`
H6056-specific:
- `SEGMENT_COUNT = 6`
- `SEGMENT_MAP` — physical segment layout
- Scene ID → effect mapping
- Custom characteristic overrides if any

### `govee_cli/commands/`
Click command groups. Each command in its own file:
- `power.py`
- `brightness.py`
- `color.py`
- `temp.py`
- `segments.py`
- `scene.py`
- `record.py`
- `replay.py`
- `effect.py`
- `music.py`
- `schedule.py`
- `group.py`
- `scan.py`
- `info.py`

### `govee_cli/scenes/capture.py`
BLE packet capture utility:
- Sniffs writes from Govee app
- Stores raw packets to JSON
- Outputs `scenes/` format

### `govee_cli/scenes/effects.py`
Built-in scene library + DIY parser.

### `govee_cli/schedule/scheduler.py`
Simple scheduler:
- Rules stored in `~/.config/govee-cli/schedule.json`
- APScheduler for timing
- Runs as part of the CLI (daemon mode: `govee-cli serve`)

### `govee_cli/cli.py`
Click root group. Global options, command discovery.

## Data Flow

```
User: govee-cli color FF5500
  → commands/color.py (parses and validates)
  → ble/gatt.py: execute(COMMAND.COLOR)
  → ble/protocol.py: encode(COLOR, "FF5500") → bytes
  → bleak: write to device GATT handle
  → wait for acknowledgment notification
  → return success/failure
```

## State Management
No persistent daemon by default. Each command:
1. Connects
2. Sends command
3. Reads response
4. Disconnects

For multi-command sequences (scenes, effects), connection persists.

## Error Handling
- `DeviceNotFound` — BLE scan found nothing
- `ConnectionFailed` — couldn't connect to MAC
- `TimeoutError` — device didn't respond
- `ProtocolError` — unexpected response bytes
- `UnsupportedDevice` — unknown device model

All wrapped in a custom exception hierarchy under `govee_cli.exceptions`.

## File Layout
```
govee-cli/
├── SPEC.md
├── ARCHITECTURE.md
├── README.md
├── pyproject.toml
├── requirements.txt
├── requirements-dev.txt
├── govee_cli/
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py
│   ├── exceptions.py
│   ├── ble/
│   │   ├── __init__.py
│   │   ├── gatt.py
│   │   ├── protocol.py
│   │   └── scanner.py
│   ├── devices/
│   │   ├── __init__.py
│   │   └── h6056.py
│   ├── commands/
│   │   └── (one file per command)
│   ├── scenes/
│   │   ├── __init__.py
│   │   ├── effects.py
│   │   └── capture.py
│   └── schedule/
│       ├── __init__.py
│       └── scheduler.py
├── tests/
│   ├── __init__.py
│   ├── test_protocol.py
│   ├── test_commands.py
│   └── (mocked BLE tests)
├── scenes/
│   └── (built-in scene JSONs)
└── .github/
    └── workflows/
        └── ci.yml
```

## BLE API Notes (bleak 3.0)

**bleak 3.0 changed the API significantly from 0.x:**

- `BLEDevice.rssi` and `BLEDevice.metadata` — **removed**. RSSI and ManufacturerData now live in `device.details['props']`
- `start_notify` callback signature — **changed** from `(handle: int, data: bytes)` to `(char: BleakGATTCharacteristic, data: bytearray) → None`
- `BleakScanner.discover(timeout)` — still works, returns list of `BLEDevice`

Always verify against installed version:
```bash
pip show bleak | grep Version
```

## Dependencies
- `bleak` — BLE GATT client
- `click` — CLI framework
- `APScheduler` — scheduling
- `pydantic` — config/state validation
- `structlog` — structured logging
