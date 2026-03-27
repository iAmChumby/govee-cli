# govee-cli

A CLI tool to control Govee smart lights over **Bluetooth Low Energy (BLE)** — no cloud, no internet required.

Currently supports the **Govee H6056 Flow Plus Light Bars** (MAC: `D0:C9:07:FE:B6:F0`).

## Installation

```bash
pip install -e .
```

## Quick Start

```bash
# Scan for devices
govee-cli scan

# Power on
govee-cli --device D0:C9:07:FE:B6:F0 power on

# Set color
govee-cli --device D0:C9:07:FE:B6:F0 color FF5500

# Set brightness
govee-cli --device D0:C9:07:FE:B6:F0 brightness 75

# Set white temperature
govee-cli --device D0:C9:07:FE:B6:F0 temp 4000
```

## Commands

| Command | Description |
|---------|-------------|
| `power on\|off` | Power on or off |
| `brightness <0-100>` | Set brightness |
| `color <RRGGBB>` | Set RGB color |
| `temp <2700-6500>` | Set white temperature (Kelvin) |
| `segments <id> <RRGGBB>` | Control individual segment |
| `scan` | Discover nearby Govee devices |
| `info` | Print device info and state |

## Status

**⚠️ Actively in development.** GATT characteristics need to be verified with a BLE sniffer before most commands will work. See [Reverse Engineering Notes](#reverse-engineering) below.

Implemented:
- ✅ Project scaffolding
- ✅ Protocol encoder (placeholders for GATT UUIDs)
- ✅ Command CLI stubs
- ✅ BLE scanner
- ✅ Unit tests for protocol encoder

Not yet implemented:
- ⏳ GATT characteristic verification (requires BLE capture)
- ⏳ Scene replay
- ⏳ DIY effects
- ⏳ Music sync
- ⏳ Scheduling daemon

## Reverse Engineering

Most commands are stubs — the GATT characteristics and command encodings are placeholders. To implement:

1. **Capture BLE traffic** from the official Govee app:
   ```bash
   govee-cli record --device D0:C9:07:FE:B6:F0 --output capture.json
   # Now trigger the effect in the Govee app on your phone
   # Press Ctrl+C to stop
   ```

2. **Inspect the capture** to find the GATT write characteristic and command bytes.

3. **Update `govee_cli/ble/protocol.py`** with the real UUIDs and packet formats.

## Development

```bash
# Set up virtual environment
python3 -m venv .venv && source .venv/bin/activate

# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type check
mypy govee_cli

# Lint
ruff check govee_cli
```

## License

MIT
