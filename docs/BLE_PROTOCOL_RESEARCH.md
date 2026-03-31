# Govee BLE Protocol — Research Summary

**Last updated:** 2026-03-30
**Sources:** egold555/Govee-Reverse-Engineering, wez/govee-py, Bluetooth-Devices/govee-ble, H6159/H6127/H6053/H6072 product docs

---

## Protocol Family Overview

The `0x33` BLE protocol is used by a very large family of Govee devices. The H6056 (our device) is part of this family.

**Sibling devices with same protocol:**
- H6053, H6056, H6061, H6062, H6063, H6065, H6066
- H6072, H6073, H6080, H6083
- H6104, H6108, H6110, H6112, H6117, H6127
- H6159, H6199, H6201, H6202
- H7050–H7065 (most)
- H7081, H7083, H7085, H7086, H7088, H7091
- H7094, H7102, H7121, H7122, H7123, H7128
- H7130, H7131, H7132, H7140–H7145, H7150–H7166
- H61XX strip controllers (H6101, H6103, H6118, H6128, H6141, H6142, H6157, H6160, H6163, H6165, H6172, H6197, H7021, H7028, H7041, H7042, H7043, H7044, H7045, H7058, H7059, H7068, H7069, H7072, H7073, H7075, H7078, H7079, H7080, H7090, H7098, H7100, H7110, H7111, H7113, H7115, H7117, H7118, H7119, H7120, H7124, H7125, H7127, H7135, H7136, H7137, H7138, H7139, H7146, H7147, H7148, H7149, H7167, H7168, H7169, H7170

**Key insight:** Many of these share the exact same command byte layout. The H6056 likely follows the same patterns as H6053, H6127, and H6159.

---

## BLE GATT Structure

**Verified for H6056:**
- Service UUID: `0000fff3-0000-1000-8000-00805f9b34fb`
- Characteristic UUID (write): `0000fff4-0000-1000-8000-00805f9b34fb` (write, no response)
- Characteristic UUID (read/notify): `0000fff4-0000-1000-8000-00805f9b34fb` (read + notify)
- Device MAC: `D0:C9:07:FE:B6:F0` (static)

**Most Govee 0x33 protocol devices use the same service/char UUIDs (fff3/fff4).**

---

## Packet Format

All commands are 20 bytes: `[0x33][CMD][payload 18 bytes][XOR checksum]`

**Checksum:** XOR of bytes 0–18 (bytes 0 through 18 inclusive), result is byte 19.

```python
def make_packet(cmd: int, payload: bytes) -> bytes:
    data = bytes([0x33, cmd]) + payload
    checksum = 0
    for b in data:
        checksum ^= b
    return data + bytes([checksum])
```

### Commands (cmd byte)

| CMD | Name | Description |
|-----|------|-------------|
| 0x01 | Device state | Response from device, sent automatically on state change |
| 0x02 | Query | Request current state |
| 0x03 | Control | Direct device control (power, color, brightness) |
| 0x04 | Advanced | Extended control (segments, DIY scenes, music, effects) |
| 0x05 | Configuration | Device configuration |

---

## Command 0x01 — Device State (response)

Device sends this automatically on state changes. Structure:

```
[0x33][0x01][0x??][0x??][...18 bytes...]
```

Byte 2 and 3 vary based on device type and state. Known patterns:

**RGBIC pattern (H6056, H6159):**
- Bytes 2–5 appear to encode color mode and actual RGB values
- Pattern `xx 00 yy 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00` for solid color mode
- The non-zero bytes likely encode the active color mode, segments state, and RGB data

**Format needs btmon capture for full resolution.**

---

## Command 0x02 — Query

Sent to request current device state. Often just: `[0x33][0x02][14x00][checksum]`

From wez/govee-py:
```
0x33, 0x02, 0x00, 0x00,   # bytes 2-5: device type specific
0x00, 0x00, 0x00, 0x00,   # bytes 6-9
0x00, 0x00, 0x00, 0x00,   # bytes 10-13
0x00, 0x00, 0x00, 0x00,   # bytes 14-17
0x00                        # byte 18
```

---

## Command 0x03 — Control (Power, Color, Brightness)

**Verified working (H6056):**

### Power
```
[0x33][0x03][0x01][power][0x00 x17][checksum]
where power: 0x01 = ON, 0x00 = OFF
```
Note: Power in byte 3 (not byte 2 as some docs suggest). Some models use byte 2.

### Color
```
[0x33][0x03][0x02][R][G][B][0x00 x15][checksum]
```
R, G, B are 0–255.

### Brightness
```
[0x33][0x03][0x04][value][0x00 x17][checksum]
where value: 0x01 (1%) to 0xFF (100%)
```

### Color + Brightness combined (H6127 pattern)
```
[0x33][0x03][0x05][R][G][B][brightness][0x00 x14][checksum]
```

---

## Command 0x04 — Advanced (Segments, DIY Scenes)

### Set Segments Count (H6159)
```
[0x33][0x04][0x35][seg_count][0x00 x17][checksum]
```
Where `seg_count` is the number of segments (0x01–0xFF).

### DIY Scene (custom colors per segment)
```
[0x33][0x04][0x36][seg_idx][R][G][B][R][G][B][...15 bytes per segment...][checksum]
```
Up to 16 segments, each with 3 bytes RGB.

---

## Command 0x05 — Music, Scenes, Effects, Configuration

This is the most complex command area. Multiple subcommands.

### 0x05 Subcommand Map

| SubCmd | Name | H6053/H6127 Pattern | Notes |
|--------|------|---------------------|-------|
| 0x01 | Music mode | `05 01 [mode] 00...` | 0x01–0x04 = music mode types |
| 0x04 | Scene mode | `05 04 [scene_id] [speed] 00...` | See scene list |
| 0x05 |? | | |
| 0x08 |? | | |
| 0x0a | DIY Scene | `05 0A [speed] [R][G][B]...` | Custom color DIY |
| 0x11 |? | | |

### Music Mode (0x05 0x01)

Switch to music sync mode. Known sub-types:

| Music Mode | Sub-byte | Description |
|------------|----------|-------------|
| Energizing | `05 01 01 00 00 00 00...` | Bright, energetic colors |
| Energetic | `05 01 02 00 00 00 00...` | |
| Spectrum | `05 01 03 00 00 00 00...` | Full color spectrum |
| Rolling | `05 01 04 00 00 00 00...` | |
| Rhythm | `05 01 05 00 00 00 00...` | Music rhythm mode |

**Note:** These sub-values differ from what the H6053 doc shows. The H6127 doc shows 0x01-0x05 music modes. Confirm with btmon capture from H6056.

Music mode requires microphone input or external audio source — not available on H6056 (no mic). This mode may not apply to the H6056 light bars.

### Scene Mode (0x05 0x04)

Known H6127 scenes (scene_id in byte 3, speed in byte 4):

| Scene ID | Name |
|---------|------|
| 0x01 | Sunrise |
| 0x02 | Sunset |
| 0x03 | Movie |
| 0x04 | Dating |
| 0x05 | Romantic |
| 0x06 | Blinking |
| 0x07 | Candlelight |
| 0x08 | Snowflake |
| 0x09 | Rainbow |
| 0x0A | Fall |
| 0x0B | Memorial Day |
| 0x0C | Deep Blue Sea |
| 0x0D | Independence Day |
| 0x0E | Halloween |
| 0x0F | Fireworks |
| 0x10 | Birthday |
| 0x11 | Valentine's |
| 0x12 | Christmas |
| 0x13 | Terror |
| 0x14 | Soft |
| 0x15 | Drunken |
| 0x16 | TC |
| 0x17 | Party |
| 0x18 | Nature |
| 0x19 | Random |
| 0x1A | Sleep |
| 0x1B | Gongzhu |
| 0x1C | Candle2 |
| 0x1D | Demo1 |
| 0x1E | Demo2 |
| 0x1F | Demo3 |
| 0x20 | Demo4 |
| 0x21 | Slower |
| 0x22 | Faster |
| 0x25 | Spring Festival |
| 0x26 | Hold |

Speed: 0x01–0xFF (1–255), larger = faster.

**Scene command format:**
```
[0x33][0x05][0x04][scene_id][speed][0x00 x15][checksum]
```

### DIY Scene (0x05 0x0A)

Custom colors animation. Format:

```
[0x33][0x05][0x0A][speed][R1][G1][B1][R2][G2][B2]...[15 bytes][checksum]
```

Where R1/G1/B1 = first color, R2/G2/B2 = second color, etc. Up to 5 color pairs in the 16 available bytes.

---

## Temperature (White Color) — H6053 Pattern

For light bars that support color temperature (white mode):

```
[0x33][0x03][0x0C][warm/cool 0x00-0xFF][brightness 0x01-0xFF][0x00 x16][checksum]
```

**Status on H6056:** Unknown if temperature command works. Needs btmon capture of the device in white/temperature mode.

The `temp` command in govee-cli (0x0C) is a best guess based on H6053/H6127 research — not yet verified against H6056 hardware.

---

## Multi-Zone / Segments — H6159 Pattern

The H6159 (RGBIC) supports segment-level control:

```
[0x33][0x04][0x35][segment_count][0x00...][checksum]
```

Then per-segment color:
```
[0x33][0x04][0x36][segment_index][R][G][B][R][G][B]...[checksum]
```

**Status on H6056:** The H6056 is a single-color light bar (not RGBIC). It does NOT have segments. The `segments` command in govee-cli may not be applicable to H6056.

---

## Color Mode Summary

Based on H6127 research (likely same as H6056):

| Mode | Command | Payload Pattern |
|------|---------|----------------|
| Solid Color | `03 02` or `03 05` | RGB + optional brightness |
| White/Temperature | `03 0C` | temp + brightness |
| Scene | `05 04` | scene_id + speed |
| Music | `05 01` | music_mode |
| DIY | `05 0A` | custom colors + speed |

---

## What Needs btmon Capture

To fully reverse-engineer the H6056:

1. **Music mode** — capture while in music sync mode (H6056 has no mic, but might accept external music input via app)
2. **Effect/scenario** — capture changing effects via the Govee app
3. **DIY scene with multiple colors** — capture the exact byte layout for multi-segment scenes
4. **State query response** — capture the full 0x01 response format to understand current state encoding
5. **Temperature/white mode** — if the H6056 supports it, capture the app setting white temperature

### How to capture with btmon

```bash
# In one terminal, start btmon:
sudo btmon

# In another, trigger the command via govee-cli:
govee-cli color <mac> ff0000
govee-cli temp <mac> 50

# The btmon log will show the exact bytes sent
```

---

## Existing Implementations

| Repo | Language | Notes |
|------|----------|-------|
| wez/govee-py | Python | Reference implementation, well-structured |
| egold555/Govee-Reverse-Engineering | Docs | Product-specific protocol docs |
| Bluetooth-Devices/govee-ble | Python | Home Assistant BLE integration |
| BeauJBurroughs/Govee-H6127-Reverse-Engineering | Docs | H6127 protocol specifics |
| Beshelmek/govee_ble_lights | Python | BLE asyncio implementation |
| timniklas/hass-govee_light_ble | Python | Home Assistant (color/brightness only) |

---

## Recommended btmon Capture Plan

Priority order for H6056:

1. **`temp` command** — does it respond? What's the response format?
2. **`scene` command** — what happens when you set a scene?
3. **`effect`** — what happens when you change effects in the Govee app?
4. **Music mode** — H6056 may not have music sync, but if it does, capture it

---

## Open Questions

1. Does H6056 support temperature (white) mode? The hardware suggests no — it's RGB, not RGBIC with white LEDs.
2. Does H6056 have segment support? Physical design (single bar) suggests no.
3. Does H6056 have music sync? No microphone on the device — music sync would require external app input.
4. What is the full 0x01 (state) response format? Needs btmon capture.
5. Are there additional 0x05 subcommands (0x05, 0x08, 0x11) for device-specific features?
6. Does the H6056 respond to the DIY scene command (0x05 0x0A)?

---

## References

- https://github.com/wez/govee-py (most complete Python implementation)
- https://github.com/egold555/Govee-Reverse-Engineering (H6053, H6127, H6072 product docs)
- https://github.com/Bluetooth-Devices/govee-ble (Home Assistant integration)
- https://github.com/BeauJBurroughs/Govee-H6127-Reverse-Engineering
