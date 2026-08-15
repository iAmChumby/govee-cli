# govee-cli

[![CI](https://github.com/iAmChumby/govee-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/iAmChumby/govee-cli/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/python-3.11+-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-linux%20%7C%20mac%20%7C%20windows-lightgrey)
![BLE](https://img.shields.io/badge/protocol-BLE%20%2F%20GATT-blueviolet)

Control Govee smart lights from the terminal. No app, no Home Assistant.

I reverse engineered the BLE protocol from hardware GATT dumps and community research, then verified it against a real H6056. Weekend project, built with [Claude Code](https://claude.ai/code).

BLE is still the direct, account-free path and it's what older Govee lights speak. Newer
WiFi+BLE hybrids have no published BLE protocol, so those go over Govee's cloud API with an
API key. The CLI picks the right transport per model — see [Transports](#transports).

## Installation

```bash
git clone https://github.com/iAmChumby/govee-cli
cd govee-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

Python 3.11+ and Bluetooth required (built-in or USB dongle both work).

On Windows, use `py` instead of `python3` and activate with `.venv\Scripts\activate`.

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
| `brightness <1-100>` | Set brightness |
| `color <RRGGBB>` | Set RGB color |
| `temp <kelvin>` | Set color temperature (range is per-model) |
| `segments <spec> [RRGGBB]` | Color and/or `--brightness` for segments — `3`, `0,4,9`, `2-6`, `0-2,8,11-14`, `all` |
| `scene <name>` | Play a scene (`scene list --device X` to see all) |
| `diy [name]` | Play a DIY scene made in the Govee app (no arg lists them) |
| `snapshot [name\|id]` | Activate a saved snapshot (no arg lists them) |
| `music <mode>` | Firmware music-reactive mode (`music list` for modes) |
| `toggle <name> on\|off` | Device feature toggles (no arg lists them) |
| `effect <file.json>` | Play a keyframe animation |
| `scan` | Find nearby Govee BLE devices |
| `scan-http` | Discover cloud devices and register them |
| `state` | Read state without sending anything |
| `info` | Print device capabilities and state |
| `schedule list\|add\|remove` | Manage time-based rules |
| `daemon [--once]` | Run the scheduler |
| `group add\|list\|state\|run` | Manage device groups |
| `config` | View or update config |
| `completion bash\|zsh\|fish` | Shell completion script |

### Transports

Which transport carries a command depends on the **model**, not the command:

| Model | Transport | Notes |
|---|---|---|
| H6022 | Govee cloud v2 | 15 segments, 94 scenes, DIY, music |
| H6056 | Govee cloud v2 + BLE | 15 cloud segments (6 over BLE), 69 scenes, DIY, per-segment brightness, 8 music modes, gradient toggle. BLE keeps keyframe effects at full frame rate |
| H6008 | Govee cloud v2 | Single zone: 56 scenes, DIY. No segments/music — the hardware rejects them |
| H6183 | Govee cloud v1 | Unverified against v2 |
| anything else | BLE | 0x33 GATT protocol |

The v1 API does not list every device — the H6022 is invisible to it — and it
carries only power/brightness/color/temp, so it cannot reach scenes, segments or
music at all. `scan-http` discovers over v2. Run it once to register everything:

```bash
govee-cli scan-http
govee-cli info --device "Shelf Lamp"
```

Capabilities differ per model, and the CLI validates against the real device
rather than a global range:

```console
$ govee-cli temp 7000 --device "Shelf Lamp"
Error: 7000K is out of range for H6022. Valid range: 2700-6500K.

$ govee-cli segments 15 FF0000 --device "Shelf Lamp"
Error: Segment(s) [15] out of range. Valid range is 0-14.
```

> **A 200 from the Govee cloud does not mean the device obeyed.** Power,
> brightness, color and temp read back through `govee-cli state`; scene, segment
> and music changes are *not* reported by the device and can only be confirmed
> by looking at the light.

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
govee-cli effect scenes/shelf_rainbow.json --device "Shelf Lamp"
```

A few example effects are in `scenes/`. `shelf_sunrise.json` and
`shelf_rainbow.json` are built for the H6022's 15 zones.

On cloud devices every frame costs API requests against a daily budget, so
playback is capped at 2fps (default 1fps), segments sharing a color in a frame are
batched into one request, and unchanged segments are skipped between frames.
BLE playback is unaffected and still runs at full speed.

## Scheduling

```bash
govee-cli schedule add --name "Morning" --time 07:00 --days Mon,Tue,Wed,Thu,Fri --command "power on"
govee-cli schedule add --name "Bedtime" --time 23:00 --days Mon,Tue,Wed,Thu,Fri,Sat,Sun --command "power off"
govee-cli schedule add --name "Shelf" --time 07:15 --days Mon --command "scene sunrise" --device "Shelf Lamp"
govee-cli schedule list
govee-cli daemon
```

Rules target one device each via `--device`; omit it to use the configured
default. The daemon routes by transport, so cloud-only models can be scheduled
too.

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
| Per-segment color | ✅ Verified on H6022 (cloud) — individual addressing over BLE still unverified |
| Built-in scenes (BLE) | ✅ Most work — a few need a multi-packet protocol I haven't reversed yet |
| Cloud scenes | ✅ Verified on all three cloud models (69 / 56 / 94) |
| DIY effects | ✅ Verified (H6056) |
| Scheduling + daemon | ✅ Working, per-rule `--device`, routes by transport |
| Shell completions | ✅ bash / zsh / fish / powershell |
| Device state | ✅ Cloud state for all models. Scene/segment/music are never reported back by the device |
| Groups | ✅ Verified across mixed BLE/cloud devices |
| Record / replay | ⏳ Stub — need a btmon session |
| Music sync | ✅ Firmware mode on H6056 + H6022 — ⏳ no host-side audio analysis |

### Per-model capability matrix

All verified against live hardware. "—" means the hardware itself rejects it.

| Feature | H6056 bars | H6008 bulb | H6022 lamp |
|---|---|---|---|
| Power / brightness / color / temp | ✅ | ✅ | ✅ |
| Color temp range | 2000–9000K | 2700–6500K | 2700–6500K |
| Firmware scenes | ✅ 69 | ✅ 56 | ✅ 94 |
| DIY scenes | ✅ | ✅ | ✅ |
| Per-segment color | ✅ 15 cloud / 6 BLE | — single zone | ✅ 15 |
| Per-segment brightness | ✅ | — | — rejected |
| Music mode | ✅ 8 modes | — | ✅ 4 modes |
| Toggles | ✅ gradient | — | — |
| Keyframe effects | ✅ BLE full speed | — single zone | ✅ cloud, ≤2fps |
| Snapshots | ✅ | — | ✅ (none saved) |

Music mode integers are **model-specific**: `beat` is 4 on the H6056, while 4 on
the H6022 is `rolling`. The CLI resolves them per model, so use the names.

`dreamViewToggle` is advertised by the API for the H6056 and then rejected by the
hardware — a reminder that the advertised capability list is a starting point for
probing, not a guarantee. `govee-cli toggle --device "Light Bars"` marks it
unverified and surfaces the device's own error rather than hiding it.

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

The `--adapter` option (Linux only) lets you pick a specific `hciX` interface. On Mac and Windows it's ignored — bleak uses the system default.

Full encoding details in `govee_cli/ble/protocol.py`.

## Device Notes

Tested on **H6056 Flow Plus** (6 segments, RGBICWW) over BLE, and on **H6008**
bulbs and an **H6022 RGBIC Table Lamp 2** (15 segments) over the cloud.

Basic BLE commands should work on other Govee BLE devices — the service UUID and
packet format are consistent across their lineup. Newer WiFi+BLE hybrids like the
H6022 are a different story: no published BLE protocol exists for them, so they
run over the cloud v2 API instead. Per-model details live in `docs/`
(`H6008_PROTOCOL.md`, `H6022_PROTOCOL.md`). If you test another model, open an issue.

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
