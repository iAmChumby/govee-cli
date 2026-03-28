# govee-cli

[![CI](https://github.com/iAmChumby/govee-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/iAmChumby/govee-cli/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/python-3.11+-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-linux-lightgrey)
![BLE](https://img.shields.io/badge/protocol-BLE%20%2F%20GATT-blueviolet)

Control Govee smart lights from the terminal over BLE. No cloud, no app, no account.

I reverse engineered the BLE protocol from hardware GATT dumps and community research, then verified it against a real H6056. Weekend project, built with [Claude Code](https://claude.ai/code).

## Installation

```bash
git clone https://github.com/iAmChumby/govee-cli
cd govee-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Python 3.11+ and a Bluetooth adapter required.

## Quick Start

```bash
# Set your device once
govee-cli config --mac D0:C9:07:FE:B6:F0

# Use it
govee-cli power on
govee-cli brightness 75
govee-cli color FF5500
govee-cli temp 4000
```

## Commands

| Command | Description |
|---------|-------------|
| `power on\|off` | Power on or off |
| `brightness <0-100>` | Set brightness |
| `color <RRGGBB>` | Set RGB color |
| `temp <2700-6500>` | Set color temperature (Kelvin) |
| `segments <id> <RRGGBB>` | Color a single segment (H6056: 0–5) |
| `scene <name>` | Play a built-in scene (`scene list` to see all) |
| `effect <file.json>` | Play a keyframe animation |
| `scan` | Find nearby Govee BLE devices |
| `info` | Print device state |
| `schedule list\|add\|remove` | Manage time-based rules |
| `daemon [--once]` | Run the scheduler |
| `group add\|list\|<name>` | Manage device groups |
| `config` | View or update config |
| `completion bash\|zsh\|fish` | Shell completion script |

## DIY Effects

JSON keyframe files, one per segment. Colors are interpolated between keyframes.

```json
{
  "name": "Crossfade",
  "fps": 10,
  "loop": true,
  "segments": [
    {"id": 0, "keyframes": [
      {"t": 0,    "color": "FF0000"},
      {"t": 2000, "color": "0000FF"},
      {"t": 4000, "color": "FF0000"}
    ]}
  ]
}
```

```bash
govee-cli effect scenes/demo.json
govee-cli effect scenes/party.json --fps 5 --no-loop
```

A few example effects are in `scenes/`.

## Scheduling

```bash
govee-cli schedule add --name "Morning" --time 07:00 --days Mon,Tue,Wed,Thu,Fri --command "power on"
govee-cli schedule add --name "Bedtime" --time 23:00 --days Mon,Tue,Wed,Thu,Fri,Sat,Sun --command "power off"
govee-cli schedule list
govee-cli daemon
```

## Shell Completions

```bash
eval "$(govee-cli completion bash)"   # bash
eval "$(govee-cli completion zsh)"    # zsh
govee-cli completion fish | source    # fish
```

## Status

| Feature | Status |
|---------|--------|
| Power on/off | ✅ Verified (H6056) |
| Brightness | ✅ Verified (H6056) |
| RGB color | ✅ Verified (H6056) |
| White temperature | ✅ Verified (H6056) |
| Per-segment color | ✅ Working — individual segment addressing unverified |
| Built-in scenes | ✅ Most work — a few need a multi-packet protocol I haven't reversed yet |
| DIY effects | ✅ Verified (H6056) |
| Scheduling + daemon | ✅ Working |
| Shell completions | ✅ bash / zsh / fish / powershell |
| Device state (info) | ⚠️ Power only — H6056 doesn't report brightness/color over BLE |
| Groups | ✅ Built — untested, need a second device |
| Record / replay | ⏳ Stub — need a btmon session |
| Music sync | ⏳ Not started |

## Protocol

All commands go through one GATT write characteristic as 20-byte packets:

```
[0x33] [cmd_type] [payload padded to 18 bytes] [XOR checksum]
```

UUIDs confirmed via GATT dump on H6056:
- **Service:** `00010203-0405-0607-0809-0a0b0c0d1910`
- **Write:** `00010203-0405-0607-0809-0a0b0c0d2b11`
- **Notify:** `00010203-0405-0607-0809-0a0b0c0d2b10`

Govee devices advertise under a random BLE address, not the static MAC. The CLI handles this automatically — configure with the MAC from the sticker and it resolves the address on each connection.

Full encoding details in `govee_cli/ble/protocol.py`.

## Device Notes

Tested on **H6056 Flow Plus** (6 segments, RGBICWW). Basic commands should work on other Govee BLE devices — the service UUID and packet format are consistent across their lineup. If you test another model, open an issue.

## Credits

The reverse engineering work that made this possible:

- **[wez/govee-py](https://github.com/wez/govee-py)** — CCT encoding (big-endian Kelvin, `FF 89 12` magic bytes) and `0xAA` state query format
- **[egold555/Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering)** — packet structure, command bytes, MODE_1501 (H6053/H6127), scene code format, `0xAA` query
- **[Beshelmek/govee_ble_lights](https://github.com/Beshelmek/govee_ble_lights)** — protocol cross-reference
- **[timniklas/hass-govee_light_ble](https://github.com/timniklas/hass-govee_light_ble)** — protocol cross-reference
- **[BeauJBurroughs/Govee-H6127-Reverse-Engineering](https://github.com/BeauJBurroughs/Govee-H6127-Reverse-Engineering)** — H6127 reference
- **Govee public API** — H6056 scene codes

## Development

```bash
pytest                      # run tests
mypy govee_cli              # type check
ruff check govee_cli        # lint
ruff check --fix govee_cli  # auto-fix
```

## License

MIT
