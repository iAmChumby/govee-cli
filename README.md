# govee-cli

A CLI tool to control Govee smart lights over **Bluetooth Low Energy (BLE)** — no cloud, no internet required.

Currently supports the **Govee H6056 Flow Plus Light Bars** (MAC: `D0:C9:07:FE:B6:F0`).

## Installation

```bash
pip install -e .
```

## Quick Start

```bash
# Set your default device (one time)
govee-cli config --mac D0:C9:07:FE:B6:F0

# Now commands work without --device
govee-cli power on
govee-cli color FF5500
govee-cli brightness 75
govee-cli temp 4000

# Or use --device on any command
govee-cli --device D0:C9:07:FE:B6:F0 power on
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
| `scene <name>` | Play built-in scene (run `scene list` to see options) |
| `group add <name> --macs AA:BB:CC:DD:EE:FF,...` | Create a device group |
| `group list` | List all groups |
| `group <name> <command>` | Run a command on all devices in a group |
| `schedule list\|add\|remove` | Manage schedules |
| `daemon [--once]` | Run the scheduler as a background daemon |
| `config [--mac ...] [--adapter ...]` | View or edit config |
| `completion bash\|zsh\|fish` | Print shell completion script |

## Configuration

Config lives at `~/.config/govee-cli/config.json`:

```json
{
  "default_mac": "D0:C9:07:FE:B6:F0",
  "default_adapter": "hci0",
  "default_timeout": 10.0
}
```

Set it once: `govee-cli config --mac D0:C9:07:FE:B6:F0`

## Status

**⚠️ Actively in development.** The GATT characteristics and packet formats are placeholders from community research — they need to be verified with a BLE sniffer before the actual light commands will work.

**Verified working:**
- ✅ BLE device scanning (`govee-cli scan`) — tested against real H6056
- ✅ Protocol encoder unit tests (26/26 passing)
- ✅ CLI registration (16 commands)
- ✅ bleak 3.0 API compatibility
- ✅ Config file, groups, daemon mode, shell completion

**Needs GATT verification before use:**
- ⏳ All light control commands (power, color, brightness, temp, segments, scene)
- ⏳ Built-in scene IDs
- ⏳ DIY effect playback

## Reverse Engineering

The GATT characteristics and command encodings are placeholders. To implement:

1. **Capture BLE traffic** from the official Govee app using `btmon` + `Wireshark` or `govee-cli record`
2. **Inspect the capture** to find the GATT write characteristic and command bytes
3. **Update `govee_cli/ble/protocol.py`** with the real UUIDs and packet formats

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

# Shell completions
eval "$(govee-cli completion bash)"
```

## License

MIT
