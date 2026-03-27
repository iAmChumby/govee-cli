# govee-cli — Specification

## What
A CLI tool to control Govee smart lights over Bluetooth Low Energy (BLE). No cloud, no internet required.

## Device
- **H6056 Flow Plus Light Bars** (MAC: `D0:C9:07:FE:B6:F0`)
- USB Bluetooth dongle on Pop!_OS (F4:4E:FC:33:69:A4)

## CLI Interface
```
govee-cli [global options] <command> [command options]
```

### Global Options
- `--device MAC` — target device MAC (default: from config)
- `--adapter HCI` — Bluetooth adapter (default: hci0)
- `--timeout SEC` — BLE operation timeout (default: 10)

### Commands

#### Power
```
govee-cli power on|off
```
Toggle power state.

#### Brightness
```
govee-cli brightness <0-100>
```
Set brightness percentage.

#### Color
```
govee-cli color <RRGGBB>
```
Set RGB color (e.g. `FF5500`).

#### Temperature
```
govee-cli temp <2700-6500>
```
Set white color temperature in Kelvin (dual LED lights).

#### Segments
```
govee-cli segments <segment-id> <RRGGBB>
```
Control individual segments on multi-zone bars.

#### Scene
```
govee-cli scene <scene-name>
```
Replicate a built-in scene from the Govee app.

#### Record
```
govee-cli record [--output FILE]
```
Capture a custom effect from the Govee app via BLE sniffer.

#### Replay
```
govee-cli replay [--file FILE [--loop]]
```
Play back a recorded or custom pattern.

#### Effect
```
govee-cli effect <effect-file>
```
Play a DIY effect from a JSON definition.

#### Music
```
govee-cli music [--input mic|file]
```
Real-time music sync mode.

#### Schedule
```
govee-cli schedule list|add|remove
```
Manage local time-based rules.

#### Groups
```
govee-cli group create <name> <MAC [MAC...]>
govee-cli group <name> <command>
```

#### Scan
```
govee-cli scan [--timeout 5]
```
Discover nearby Govee BLE devices.

#### Info
```
govee-cli info
```
Print device info and current state.

## Architecture

### Layer Overview
```
┌─────────────────────────────────┐
│          CLI (click)            │
├─────────────────────────────────┤
│     Command Dispatcher          │
├──────────┬──────────┬───────────┤
│ ble/     │ scenes/  │ schedule/ │
│ gatt.py  │ capture.py│ scheduler.py│
├──────────┴──────────┴───────────┤
│     ble/ BleakClient wrapper     │
└─────────────────────────────────┘
```

### ble/gatt.py
Core GATT interface. Handles:
- Device connection/disconnection
- Characteristic reads/writes/notifications
- Command encoding (Govee proprietary)
- State polling

### ble/protocol.py
Govee BLE protocol definitions:
- Command opcodes
- GATT characteristic UUIDs (discovered via Wireshark/BLE sniffer)
- Packet structure and checksum

### ble/scanner.py
Device discovery via BLE scanning.

### devices/h6056.py
H6056-specific implementation:
- Segment map
- Scene definitions
- Custom characteristic mappings

### commands/
Click command implementations for each CLI command.

### scenes/capture.py
Pattern capture: sniff BLE packets from Govee app.

### scenes/effects.py
Built-in scene definitions + DIY effect format.

### schedule/scheduler.py
Local scheduling engine (no cloud dependency).

## DIY Effect Format
```json
{
  "name": "my_effect",
  "segments": [
    {"id": 0, "keyframes": [
      {"t": 0, "color": "FF0000"},
      {"t": 500, "color": "00FF00"},
      {"t": 1000, "color": "0000FF"}
    ]}
  ],
  "loop": true,
  "fps": 30
}
```

## Reverse Engineering Notes

### GATT Characteristics (TBD — requires BLE sniffer)
- Light state (power, brightness, color)
- Segment control
- Built-in scenes
- Custom effects
- Music sync

### Approach
1. Use `bleak` + Wireshark/BLE sniffer to capture traffic from Govee app
2. Identify writable characteristics for each command type
3. Map command bytes to GATT writes
4. Verify by replaying captured patterns

### References
- Govee BLE protocol research: https://github.com/egor EEprom/govee-ble
- Bleak library: https://github.com/hbldh/bleak

## Status

| Component | Status | Notes |
|-----------|--------|-------|
| Project scaffolding | ✅ Done | `pyproject.toml`, CI, venv setup |
| BLE scanner | ✅ Done | bleak 3.0 API verified against real device |
| BLE GATT client | ✅ Done | bleak 3.0 API — connection, write, notify |
| Protocol encoder | ✅ Done | Unit tests passing (26/26) |
| CLI commands (power, color, brightness, temp, segments, scan, info) | ✅ Done | Connected to BLE layer; needs GATT verification |
| CLI commands (scene, record, replay, effect, music) | ⏳ Stub | Require GATT verification before use |
| Config file | ✅ Done | `~/.config/govee-cli/config.json` — default MAC, adapter, groups |
| Groups | ✅ Done | Create, list, run commands across devices in parallel |
| Daemon mode | ✅ Done | `govee-cli daemon [--once]` — scheduler as background process |
| Shell completion | ✅ Done | bash/zsh/fish/powershell via `govee-cli completion` |
| Built-in scene registry | ⚠️ Unverified | Scene IDs are community guesses. **Must verify with capture** |
| DIY effects | ✅ Format defined | Parser + JSON format done; playback needs GATT verification |
| Music sync | ⏳ Not started | Requires audio analysis library + GATT research |
| Scheduling engine | ✅ Done | Full CRUD, JSON persistence, daemon mode wired up |
| GATT characteristic UUIDs | ⚠️ Placeholder | UUIDs in `ble/protocol.py` are community research placeholders. **Must verify with BLE sniffer** |
| GATT packet formats | ⚠️ Placeholder | Packet structure (0x33 prefix, checksum) derived from community research. **Must verify with capture** |

**Next critical step:** BLE capture to verify GATT UUIDs and packet formats.

## Quality bar
- CLI must work offline (no cloud calls ever)
- Commands respond in < 2 seconds
- Graceful degradation on connection loss
- All protocol encoder logic has unit tests
- BLE commands verified against real device captures before claiming working
