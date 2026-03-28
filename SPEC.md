# govee-cli — Specification

## What

A CLI tool to control Govee smart lights over Bluetooth Low Energy (BLE). No cloud, no internet required.

## Device

- **Primary:** H6056 Flow Plus Light Bars — static MAC `D0:C9:07:FE:B6:F0`, random BLE address `DD:6E:86:46:44:0C` (`Govee_H6056_440C`)
- **Bluetooth adapter:** hci0 (USB dongle, `F4:4E:FC:33:69:A4`)

## CLI Interface

```
govee-cli [global options] <command> [command options]
```

### Global Options

- `--device MAC` — target device MAC (default: from config)
- `--adapter HCI` — Bluetooth adapter (default: hci0)
- `--timeout SEC` — BLE operation timeout (default: 10)
- `-v / --verbose` — enable debug logging

### Commands

#### Power
```
govee-cli power on|off
```

#### Brightness
```
govee-cli brightness <0-100>
```

#### Color
```
govee-cli color <RRGGBB>
```

#### Temperature
```
govee-cli temp <2700-6500>
```
White color temperature in Kelvin.

#### Segments
```
govee-cli segments <segment-id> <RRGGBB>
```
Per-segment color on multi-zone devices. H6056 has 6 segments (0–5).

#### Scene
```
govee-cli scene <scene-name>
govee-cli scene list
```
Play a built-in scene. Scene codes are 16-bit little-endian values.

#### Effect
```
govee-cli effect <effect-file.json> [--fps N] [--no-loop]
```
Play a DIY keyframe animation. Colors are linearly interpolated between keyframes and sent as per-segment BLE commands.

#### Record
```
govee-cli record [--output FILE]
```
Capture BLE packets from the Govee app via btmon. **Not yet implemented.**

#### Replay
```
govee-cli replay <file> [--loop]
```
Play back a captured packet sequence. **Not yet implemented.**

#### Music
```
govee-cli music [--input mic|file]
```
Real-time music sync. **Not yet implemented.**

#### Scan
```
govee-cli scan [--timeout 5]
```

#### Info
```
govee-cli info
```
Prints power state. H6056 does not report brightness or color in its BLE state response.

#### Groups
```
govee-cli group add <name> --macs AA:BB:CC:DD:EE:FF,...
govee-cli group list
govee-cli group <name> <command>
```

#### Schedule
```
govee-cli schedule list
govee-cli schedule add --name NAME --time HH:MM --days Mon,Wed,Fri --command "power on"
govee-cli schedule remove <id>
```

#### Daemon
```
govee-cli daemon [--once]
```
Run the scheduler as a long-lived process.

#### Config
```
govee-cli config [--mac MAC] [--adapter HCI] [--timeout SEC]
```

#### Completion
```
govee-cli completion bash|zsh|fish|powershell
```

## DIY Effect Format

```json
{
  "name": "my_effect",
  "fps": 10,
  "loop": true,
  "segments": [
    {"id": 0, "keyframes": [
      {"t": 0,    "color": "FF0000"},
      {"t": 1000, "color": "00FF00"},
      {"t": 2000, "color": "0000FF"}
    ]}
  ]
}
```

`t` is milliseconds from effect start. Colors are hex RGB strings. FPS controls how often segment commands are sent — BLE limits practical throughput to ~10–15 fps for multi-segment effects.

## Protocol

All commands are written to a single GATT characteristic. Packet structure (confirmed via hardware dump):

```
[0x33] [cmd_type] [payload, padded to 18 bytes] [XOR checksum]  = 20 bytes total
```

| Command | cmd_type | Payload |
|---------|----------|---------|
| Power | 0x01 | `0x01` (on) / `0x00` (off) |
| Brightness | 0x04 | `[level]` (0–100) |
| Color (MODE_1501) | 0x05 | `0x15 0x01 R G B 0x00×5 0xFF 0xFF` |
| Color temp | 0x05 | `0x15 0x01 0xFF×3 kelvin_hi kelvin_lo 0xFF 0x89 0x12 0xFF 0xFF 0x00×5` |
| Scene | 0x05 | `0x04 code_lo code_hi` (16-bit LE scene code) |
| Segment | 0x05 | `0x15 0x01 R G B 0x00×5 seg_lo seg_hi` (16-bit bitmask) |
| State query | 0xAA | `0x01 0x00×17 0xAB` |

GATT UUIDs (confirmed on H6056):
- Service: `00010203-0405-0607-0809-0a0b0c0d1910`
- Write: `00010203-0405-0607-0809-0a0b0c0d2b11`
- Notify: `00010203-0405-0607-0809-0a0b0c0d2b10`

## Status

| Component | Status | Notes |
|-----------|--------|-------|
| BLE scanning | ✅ Done | bleak 3.0, RSSI from AdvertisementData |
| BLE connection | ✅ Done | Static MAC + scan fallback for random address |
| Power | ✅ Verified | H6056 hardware tested |
| Brightness | ✅ Verified | H6056 hardware tested |
| Color | ✅ Verified | MODE_1501 confirmed on H6056 |
| Temperature | ✅ Verified | Big-endian Kelvin, CCT magic bytes confirmed |
| Segments | ✅ Implemented | 16-bit bitmask format; individual addressing unverified |
| Scenes | ✅ Most working | ~27 real H6056 codes; Siren needs multi-packet 0xA3 protocol |
| DIY effects | ✅ Verified | Keyframe interpolation, fire-and-forget BLE writes |
| Info / state | ⚠️ Power only | H6056 returns zeros for brightness/color in 0xAA response |
| Config | ✅ Done | `~/.config/govee-cli/config.json` |
| Groups | ✅ Done | Untested — requires multiple devices |
| Scheduling | ✅ Done | JSON persistence, HH:MM + day matching |
| Daemon | ✅ Done | asyncio loop, SIGINT/SIGTERM handling |
| Shell completion | ✅ Done | bash / zsh / fish / powershell |
| Record / replay | ⏳ Stub | Requires btmon capture session |
| Music sync | ⏳ Not started | Requires audio library + protocol research |
