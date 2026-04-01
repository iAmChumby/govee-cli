# Govee BLE Protocol — Research Summary

**Last updated:** 2026-03-30 (corrected — see notes below)
**Primary sources:** All repo docs + code read in full before writing this
**⚠️ NOTE:** This document was originally written from web research before reading all repo docs. Several findings below were incorrect — the implementation is more complete than initially described. Verify against actual code.

---

## ⚠️ Corrections to Initial Research

The initial version of this document (written from web research) contained significant errors:

| Claim | Reality |
|-------|---------|
| `effect` command not implemented | WRONG — DIY keyframe animations work via `encode_segment` (per-frame per-segment) |
| `scene` command uncertain | WRONG — 26 H6056 scene codes already implemented |
| H6056 might use MODE_2 | WRONG — H6056 uses MODE_1501 (`0x15 0x01`), not MODE_2 (`0x02`) |
| Music sync command byte 0x07 | UNVERIFIED — no `encode_effect` or `encode_music` exists in protocol.py |
| `btmon` can be used for captures | WRONG — btmon crashes immediately on this machine (BlueZ bug, documented in CLAUDE.md) |

---

## What IS Working (from actual codebase)

### Confirmed Working on H6056

| Feature | Command | Format | Status |
|---------|---------|--------|--------|
| Power | 0x33 0x01 | `01` = on, `00` = off | ✅ Implemented |
| Brightness | 0x33 0x04 | 0x01–0xFF (1–255) | ✅ Implemented |
| Color (MODE_1501) | 0x33 0x05 | `15 01 RR GG BB 00×5 FF FF` | ✅ Implemented |
| Temperature | 0x33 0x05 | `15 01 FF FF FF <K_hi> <K_lo> FF 89 12 FF FF` | ✅ Implemented |
| Scene (built-in) | 0x33 0x05 | `04 <code_lo> <code_hi>` | ✅ 26 scenes |
| DIY Effect | 0x33 0x05 | Per-segment keyframe animation via `encode_segment` | ✅ Working |
| Read state | 0xAA | `AA 01 00×17 AB` | ✅ Implemented |
| Per-segment color | 0x33 0x05 | `15 01 RR GG BB 00×5 <seg_lo> <seg_hi>` | ✅ Bitmask confirmed |

### What Is NOT Working

| Feature | Status | Notes |
|---------|--------|-------|
| Music sync | ❌ Stub only | `"Music sync not yet implemented — requires audio analysis + GATT research."` |
| Built-in effect command (0x08) | ❌ Not implemented | No `encode_effect` function exists in protocol.py |
| Individual segment byte targeting | ⚠️ Unverified | `encode_segment` uses bitmask; byte-level targeting needs capture |

---

## Device Family

The H6056 uses MODE_1501 protocol (`0x15 0x01` sub-mode byte), part of the large RGBIC/RGBWW family that includes H6053, H6061–H6066, H6072, H6080, H6127, H6159, H6104, H7100 series, and many more.

MODE_2 (`0x02` sub-mode byte) is for simpler bulbs without segment support (H6008, H6127 basic mode, etc.) — **not used by H6056**.

---

## Verified Packet Formats (from codebase)

### Power
```
33 01 01 [0x00×18] CHECKSUM  → ON
33 01 00 [0x00×18] CHECKSUM  → OFF
```

### Brightness
```
33 04 [level] [0x00×18] CHECKSUM
where level: 0x01 (1%) to 0xFF (100%)
```

### Color — MODE_1501 (H6056)
```
33 05 15 01 [R] [G] [B] 00 00 00 00 00 FF FF [zeros] CHECKSUM
```
Bytes 10-11 = `FF FF` = all segments (16-bit segment bitmask)

### Temperature — MODE_1501 (H6056)
```
33 05 15 01 FF FF FF [K_hi] [K_lo] FF 89 12 FF FF [zeros] CHECKSUM
```
`89 12` = CCT magic bytes (confirmed). Kelvin big-endian.

### Color — MODE_2 (H6008, simple bulbs)
```
33 05 02 [R] [G] [B] [zeros] CHECKSUM
```

### Temperature — MODE_2 (H6008)
```
33 05 02 FF FF FF 01 [K_hi] [K_lo] [zeros] CHECKSUM
```
`01` = CCT flag byte

### Scene (H6056)
```
33 05 04 [code_lo] [code_hi] [zeros] CHECKSUM
```
16-bit little-endian. 26 scenes implemented (see `BuiltInScene` in `scenes/effects.py`).

### Per-Segment Color — MODE_1501
```
33 05 15 01 [R] [G] [B] 00 00 00 00 00 [seg_lo] [seg_hi] CHECKSUM
```
`[seg_lo][seg_hi]` = 16-bit bitmask (bit per segment).

### State Query
```
AA 01 [0x00×17] AB
```

---

## btmon Status

**btmon is broken on this machine.** Documented in CLAUDE.md:

```
*** buffer overflow detected ***: terminated
SIGABRT from glibc stack protector, BlueZ 5.72 bug
Building 5.75 from source did not fix it.
```

**Workaround options documented in H6008_PROTOCOL.md:**
1. nRF52840 USB dongle with Nordic sniffer firmware (~$10-15)
2. iOS Bluetooth Logging profile + sysdiag tar.gz
3. WiFi + Govee LAN API (requires own network, not eduroam)

---

## H6008 (Different Device — Blocked)

The H6008 is a separate project in this repo (different device, different MAC prefix `GVH...`). Its protocol is **undocumented** and **completely blocked** — none of the `0x33` family works on it. The fff6 service has Matter CHIPoBLE characteristics but they're dormant/unused.

This is a separate hardware revision with no public reverse engineering. See `docs/H6008_PROTOCOL.md`.

---

## Open Questions

1. **Individual segment byte targeting** — does `encode_segment` bitmask approach work for individual segments, or is byte-level per-segment addressing needed?
2. **Music sync protocol** — does H6056 respond to any 0x07 command at all? No `encode_music` exists.
3. **Built-in effect (0x08)** — is there a separate effect command beyond DIY keyframes?
4. **Full state notification format** — `parse_state` has fallbacks that may not match actual device notification bytes

---

## References

- `govee_cli/ble/protocol.py` — **authoritative** for H6056 command formats
- `docs/H6008_PROTOCOL.md` — H6008 (blocked device, separate issue)
- `govee_cli/scenes/effects.py` — `BuiltInScene` class with 26 H6056 codes
- `govee_cli/commands/effect.py` — DIY keyframe animation player
- `wez/govee-py` — reference implementation
- `egold555/Govee-Reverse-Engineering` — H6053/H6127 product docs
- `Bluetooth-Devices/govee-ble` — Home Assistant BLE integration
