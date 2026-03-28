# govee-cli

Control Govee smart lights from the terminal — over **Bluetooth Low Energy**, no cloud, no internet, no Govee account.

Built by [Luke Edwards](https://lukeedwards.me) as a weekend project to experiment with [Claude Code](https://claude.ai/code). The BLE protocol was reverse engineered from hardware GATT dumps and community research, then verified against a real **Govee H6056 Flow Plus Light Bar**.

If you're already running your own infrastructure and tired of smart home devices phoning home, this is for you.

## Installation

```bash
git clone https://github.com/iAmChumby/govee-cli
cd govee-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Requires Python 3.11+ and a Bluetooth adapter.

## Quick Start

```bash
# Set your device once
govee-cli config --mac D0:C9:07:FE:B6:F0

# Then just use it
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
| `temp <2700-6500>` | Set white color temperature (Kelvin) |
| `segments <id> <RRGGBB>` | Set color on a single segment (H6056: 0–5) |
| `scene <name>` | Play a built-in scene (`scene list` to see all) |
| `effect <file.json>` | Play a DIY keyframe animation |
| `scan` | Discover nearby Govee BLE devices |
| `info` | Print device state |
| `schedule list\|add\|remove` | Manage time-based rules |
| `daemon [--once]` | Run the scheduler as a background process |
| `group add\|list\|<name>` | Manage and command device groups |
| `config` | View or update config |
| `completion bash\|zsh\|fish` | Print shell completion script |

## DIY Effects

Define keyframe animations in JSON. Colors are linearly interpolated between keyframes and sent as per-segment BLE commands.

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

A few example effects are included in `scenes/`.

## Scheduling

```bash
govee-cli schedule add --name "Morning" --time 07:00 --days Mon,Tue,Wed,Thu,Fri --command "power on"
govee-cli schedule add --name "Bedtime" --time 23:00 --days Mon,Tue,Wed,Thu,Fri,Sat,Sun --command "power off"
govee-cli schedule list
govee-cli daemon  # runs in foreground; use systemd/nohup for background
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
| Per-segment color | ✅ Implemented (individual addressing unverified) |
| Built-in scenes | ✅ Most working — a few need multi-packet protocol |
| DIY effects | ✅ Verified (H6056) |
| Scheduling + daemon | ✅ Working |
| Shell completions | ✅ bash / zsh / fish / powershell |
| Device state (info) | ⚠️ Power only — H6056 doesn't report brightness/color over BLE |
| Groups | ✅ Implemented — untested (need multiple devices) |
| Record / replay | ⏳ Stub — needs btmon capture |
| Music sync | ⏳ Not implemented |

## How It Works

Govee uses a proprietary BLE protocol on top of standard GATT. Every command is a 20-byte packet written to a single characteristic:

```
[0x33] [cmd_type] [payload, padded to 18 bytes] [XOR checksum]
```

The UUIDs and packet formats were confirmed via a hardware GATT dump on the H6056. Most Govee BLE devices share the same service UUID, so other models should work with minimal changes.

One quirk: Govee devices advertise under a **random BLE address** rather than their static MAC. govee-cli handles this automatically — configure with the MAC from the sticker and it scans to resolve the address on each connection.

See `govee_cli/ble/protocol.py` for the full encoding details.

## Device Notes

Confirmed working on **H6056 Flow Plus** (6 segments, RGBICWW).

Other Govee BLE devices will likely work for basic commands (power, brightness, color). Segmented effects are H6056-specific. If you test another model, open an issue with your findings.

## Acknowledgements

This project wouldn't exist without the people who did the hard work of reverse engineering the Govee BLE protocol and publishing their findings:

- **[wez/govee-py](https://github.com/wez/govee-py)** — CCT/white temperature encoding: big-endian Kelvin with fixed `FF 89 12` CCT magic bytes; `0xAA` state query packet format
- **[egold555/Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering)** — packet structure (`0x33` command header, XOR checksum, 20-byte total); command type bytes; MODE_1501 segment format from H6053/H6127 (extrapolated to H6056); scene code encoding (16-bit little-endian); `0xAA` state query
- **[Beshelmek/govee_ble_lights](https://github.com/Beshelmek/govee_ble_lights)** — BLE protocol cross-reference
- **[timniklas/hass-govee_light_ble](https://github.com/timniklas/hass-govee_light_ble)** — BLE protocol cross-reference
- **[BeauJBurroughs/Govee-H6127-Reverse-Engineering](https://github.com/BeauJBurroughs/Govee-H6127-Reverse-Engineering)** — H6127 protocol reference
- **Govee public API** (`govee-public.s3.amazonaws.com`) — real H6056 scene codes and scene metadata

The GATT service/characteristic UUIDs and final packet formats were confirmed against a real H6056 device.

## Development

```bash
pytest                      # run tests
mypy govee_cli              # type check
ruff check govee_cli        # lint
ruff check --fix govee_cli  # auto-fix
```

## License

MIT
