# govee-cli

A CLI tool to control Govee smart lights over **Bluetooth Low Energy (BLE)** — no cloud, no internet required.

Built as a weekend project to experiment with [Claude Code](https://claude.ai/code). The protocol was reverse engineered from hardware GATT dumps and community research, then verified against a real **Govee H6056 Flow Plus Light Bar**.

## Installation

```bash
git clone https://github.com/iAmChumby/govee-cli
cd govee-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

## Quick Start

```bash
# Set your default device once
govee-cli config --mac D0:C9:07:FE:B6:F0

# Control it
govee-cli power on
govee-cli brightness 75
govee-cli color FF5500
govee-cli temp 4000

# Or pass --device on any command
govee-cli --device D0:C9:07:FE:B6:F0 power on
```

## Commands

| Command | Description |
|---------|-------------|
| `power on\|off` | Power on or off |
| `brightness <0-100>` | Set brightness |
| `color <RRGGBB>` | Set RGB color |
| `temp <2700-6500>` | Set white color temperature (Kelvin) |
| `segments <id> <RRGGBB>` | Set color on a single segment (H6056: 0–5) |
| `scene <name>` | Play a built-in scene (`scene list` to see options) |
| `effect <file.json>` | Play a DIY keyframe animation |
| `scan` | Discover nearby Govee BLE devices |
| `info` | Print device power state |
| `group add <name> --macs <MAC,...>` | Create a device group |
| `group <name> <command>` | Run a command on all devices in a group |
| `schedule list\|add\|remove` | Manage time-based rules |
| `daemon [--once]` | Run the scheduler as a background process |
| `config [--mac ...] [--adapter ...]` | View or update config |
| `completion bash\|zsh\|fish` | Print shell completion script |

## Shell Completions

```bash
# bash
eval "$(govee-cli completion bash)"

# zsh
eval "$(govee-cli completion zsh)"

# fish
govee-cli completion fish | source
```

## DIY Effects

Effects are JSON files that define per-segment color keyframes. Colors are linearly interpolated between keyframes.

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
govee-cli effect scenes/party.json --fps 5
govee-cli effect scenes/sunrise.json --no-loop
```

## Scheduling

```bash
# Add a schedule
govee-cli schedule add --name "Morning" --time 07:00 --days Mon,Tue,Wed,Thu,Fri --command "power on"

# List schedules
govee-cli schedule list

# Run the daemon (executes schedules at their configured times)
govee-cli daemon
```

## Configuration

Config lives at `~/.config/govee-cli/config.json`:

```json
{
  "default_mac": "D0:C9:07:FE:B6:F0",
  "default_adapter": "hci0",
  "default_timeout": 10.0
}
```

## Status

| Feature | Status |
|---------|--------|
| BLE scanning | ✅ Working |
| Power on/off | ✅ Verified on H6056 |
| Brightness | ✅ Verified on H6056 |
| RGB color | ✅ Verified on H6056 |
| White temperature | ✅ Verified on H6056 |
| Per-segment color | ✅ Implemented (individual segment addressing unverified) |
| Built-in scenes | ✅ Most working — Siren and a few others need multi-packet protocol |
| DIY effects | ✅ Verified on H6056 |
| Device state (info) | ⚠️ Power only — H6056 does not report brightness/color over BLE |
| Shell completions | ✅ bash / zsh / fish / powershell |
| Scheduling + daemon | ✅ Working |
| Groups | ✅ Implemented — untested (requires multiple devices) |
| Record / replay | ⏳ Stub — requires btmon capture |
| Music sync | ⏳ Not implemented |

## Device Notes (H6056)

The H6056 advertises under a random BLE address (`Govee_H6056_440C`) rather than its static MAC. govee-cli handles this automatically — configure with the static MAC and it will scan to resolve the random address on each connection.

```bash
govee-cli config --mac D0:C9:07:FE:B6:F0   # static MAC from the sticker
govee-cli scan                               # will show the random address it's advertising
```

## Protocol

The Govee BLE protocol uses a single GATT write characteristic for all commands. Packets are always 20 bytes: `[0x33][cmd_type][payload padded to 18 bytes][XOR checksum]`.

UUIDs confirmed via hardware GATT dump on H6056:
- **Service:** `00010203-0405-0607-0809-0a0b0c0d1910`
- **Write:** `00010203-0405-0607-0809-0a0b0c0d2b11`
- **Notify:** `00010203-0405-0607-0809-0a0b0c0d2b10`

See `govee_cli/ble/protocol.py` for full encoding details.

## Development

```bash
pytest                        # run tests
mypy govee_cli                # type check
ruff check govee_cli          # lint
ruff check --fix govee_cli    # auto-fix lint
```

## License

MIT
