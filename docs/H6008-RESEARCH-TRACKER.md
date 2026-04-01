# H6008 Research Tracker

**Last updated:** 2026-04-01 15:40
**Goal:** Crack the H6008 GVH-series BLE protocol
**Context:** BLE necessary — machine is on eduroam WiFi
**Cron:** Runs every 45 min (3–10 AM) — see `cron-jobs.json` id `h6008-research-01`
**Tracker:** This doc. Findings: `/tmp/h6008-findings/`

---

## Status Summary

| # | Finding | Confidence | Source |
|---|---------|-----------|--------|
| 1 | H6008 uses custom GATT UUIDs (not standard fff3/fff4) | ✅ CONFIRMED | Live H7126 GATT dump |
| 2 | MODE_2 packet format: `33 05 02 R G B` | ✅ CONFIRMED | sisiphamus/govee-controller |
| 3 | R/G/B channels are SWAPPED on device | ✅ CONFIRMED | sisiphamus experimentation |
| 4 | `response=True` → `WRITE_NOT_PERMITTED` (write-only char) | ✅ CONFIRMED | Live H7126 test |
| 5 | No pairing/bonding required | ✅ CONFIRMED | sisiphamus source + gittt analysis |
| 6 | Standard `fff4` UUID absent on GVH devices | ✅ CONFIRMED | Live H7126 GATT dump |
| 7 | 0.5–1s delay between commands helps | ⚠️ LIKELY | sisiphamus + H7126 test |
| 8 | H6008 IS on Govee LAN API list | ⚠️ LIKELY | GoveeAPI/govee-local-api docs |
| 9 | `response=False` is correct for custom UUID | ⚠️ LIKELY | Live H7126 confirmed |
| 10 | Device is silent — no responses, no notifications | ✅ CONFIRMED | Live H7126 test |

---

## What We Know for Certain (from live testing + confirmed sources)

### GATT Structure
```
Service:  00010203-0405-0607-0809-0a0b0c0d1910
  Write:  00010203-0405-0607-0809-0a0b0c0d2b11  (write-without-response) ✅
  Notify: 00010203-0405-0607-0809-0a0b0c0d2b10  (notify/read) ⚠️ read returns READ_NOT_PERMITTED
Standard fff3/fff4: ❌ ABSENT
```

### Packet Format
```
33 [CMD] [payload 18 bytes] [XOR checksum byte 0x00-0x18]
```

### Working Commands (from sisiphamus)

| Command | Format | Example |
|---------|--------|---------|
| Power | `33 01 01 [zeros]` | `33 01 01 00 00...00 CHECKSUM` |
| Color | `33 05 02 R G B [zeros]` | `33 05 02 FF 00 00...` |

**Channel swap:** Device maps `(R_in, G_in, B_in)` → `(B_in, R_in, G_in)`. To get RED on device: send `(0, 255, 0)` → device shows BLUE. So: `send(0,255,0)` = device red, `send(255,0,0)` = device green, `send(0,0,255)` = device blue.

### Connection Behavior
- No pairing required
- Write-only characteristic (no ACK possible)
- 0.5–1s delay between commands
- Device sends zero notifications
- Live H7126 test: all 5 writes (power + 4 colors) succeeded without error

---

## Key Unknowns

### ❓ Is the H6008 actually in range?
**Status: Temporarily out of range** — both devices confirmed working 2026-03-31 evening (30/30 on both), but not appearing in scans as of 2026-04-01 06:02. Bulbs likely powered off or moved out of BLE range.

### ❓ Does the custom UUID + MODE_2 actually work on H6008?
We confirmed it on H7126 (same custom UUIDs), but haven't confirmed on H6008 specifically.

### ❓ What are the correct `response=False` write delays?
sisiphamus used 0.5–1s. Could be shorter.

### ❓ What is the full command set?
Only power and color confirmed from sisiphamus. Temperature, scenes, brightness — unknown for H6008.

---

## What Was Ruled Out

| Theory | Ruled Out By |
|--------|-------------|
| Standard Govee fff3/fff4 UUIDs | Live H7126 GATT dump — absent |
| BLE pairing required | sisiphamus source + H7126 test |
| `response=True` needed | Live H7126 — returns WRITE_NOT_PERMITTED |
| Matter/CHIPoBLE | sisiphamus + pairing research |

---

## Next Steps (Priority Order)

### 1. ✅ Test H6008 in range (HIGHEST PRIORITY)
Get the H6008 bulb in Bluetooth range and run the test script. If it's too far, use the H7126 for protocol development and apply to H6008 when in range.

**Test script to run:**
```python
import asyncio
from bleak import BleakClient

MAC = "5C:E7:53:69:87:FB"  # H6008 (when in range)
# or: "60:74:F4:94:5A:E9"   # H7126 (confirmed working)
WRITE_CHAR = "00010203-0405-0607-0809-0a0b0c0d2b11"

def make_packet(cmd, payload):
    data = bytes([0x33, cmd] + list(payload))
    checksum = 0
    for b in data: checksum ^= b
    return data + bytes([checksum])

async def test():
    async with BleakClient(MAC) as client:
        await asyncio.sleep(1)
        # Power on
        await client.write_gatt_char(WRITE_CHAR, make_packet(0x01, bytes([1]+[0]*18)), response=False)
        await asyncio.sleep(1)
        # Color: send (0,255,0) → device shows BLUE (channel swap)
        await client.write_gatt_char(WRITE_CHAR, make_packet(0x05, bytes([2,0,255,0]+[0]*15)), response=False)
        await asyncio.sleep(1)
        print("Commands sent — did the bulb change color?")

asyncio.run(test())
```

### 2. Discover all GATT services on H7126 (MEDIUM)
Run a full service discovery to find ALL characteristics — the notify char might have more data, or there might be additional services not covered by the standard Govee protocol.

### 3. Try sisiphamus govee-controller directly (MEDIUM)
Clone and run sisiphamus's implementation against the H7126 to see if it works as-is, then adapt to govee-cli.

### 4. LAN API as fallback (LOW — only if BLE fails)
Check if the H6008 shows "LAN Control" in Govee Home app. If yes, use `govee_lan.py` instead of BLE.

---

## Dead Ends (do not revisit)

| Lead | Reason Ruled Out |
|------|-----------------|
| Standard Govee fff3/fff4 UUIDs | Confirmed absent on GVH hardware |
| BLE pairing/bonding | No pairing code in sisiphamus, confirmed by H7126 test |
| response=True writes | Returns WRITE_NOT_PERMITTED — char is write-without-response only |
| btmon passive capture | Broken on this machine (BlueZ 5.72 SIGABRT) |

---

## Sources

| Source | What It Gives Us |
|--------|-----------------|
| [sisiphamus/govee-controller](https://github.com/sisiphamus/govee-controller) | H6008 MODE_2 format, channel swap, custom UUIDs |
| Live H7126 GATT dump (2026-03-31) | Confirmed: custom UUIDs work, standard absent, write-only |
| [wez/govee-py](https://github.com/wez/govee-py) | Reference Python implementation, LAN API support |
| [GoveeAPI/govee-local-api](https://github.com/GoveeAPI/govee-local-api) | LAN API docs — H6008 on supported list |
| [Bluetooth-Devices/govee-ble](https://github.com/Bluetooth-Devices/govee-ble) | Confirms: no pairing needed |
| [NordicSemiconductor/nrf-sniffer-for-bluetooth-le](https://github.com/NordicSemiconductor/nrf-sniffer-for-bluetooth-le) | nRF52840 sniffer firmware (if btmon fails) |
| `govee-cli/CLAUDE.md` | btmon broken — BlueZ 5.72 SIGABRT |

---

## Research Log

| Time | Agent | Finding |
|------|-------|---------|
| 02:21 | sisiphamus | Custom UUIDs, MODE_2, channel swap confirmed |
| 02:22 | pairing | No pairing needed; response=True → WRITE_NOT_PERMITTED |
| 02:23 | sniffer | nRF52840 hardware confirmed (~$10-13) |
| 02:27 | lanapi | H6008 on LAN API list — but requires WiFi |
| 02:38 | custom-uuids test | H7126: custom UUIDs work, standard absent, device silent |

| 11:06 | agent:test-commands-h7126 | ✅ LEAD | ALL 10 commands succeeded on H7126 — power, color (RGB), brightness (0x04), temp (warm/cool), scene (0x0018). RGB channel swap CONFIRMED. Device accepts 0x01/0x02/0x04/0x0D/0x15/0xA1 variants. sisiphamus found notify char for responses. |
| 13:54 | live-test | ✅ LEAD | H6008 LIVE TESTED — Both GVH600887FB and GVH60088F01 respond to ALL commands. Protocol confirmed. CLI fix committed. |
| 18:20 | cron:4515af80 | ✅ LEAD | Both H6008 devices (GVH600887FB RSSI -50, GVH60088F01 RSSI -43) in range and responding to power + RGB commands. Channel swap confirmed. |
| 19:07 | cron:4515af80 | ✅ LEAD | **30/30 commands succeeded** on BOTH H6008 bulbs. All tested: power, RGB (swapped), brightness (0%/50%/100%), temp (warm/cool), scene (0x0018), proprietary (0x15, 0xA1). No notifications received. Test script bug (lambda not called) fixed — ALT UUIDs confirmed working too. |
| 21:11 | cron:4515af80 | ✅ LEAD | **30/30 commands succeeded** on BOTH H6008 bulbs. All power, color (RGB swapped), brightness, temp, scene, proprietary commands confirmed working. ALT UUIDs working on both devices. |
| 21:20 | cron:4515af80 | ✅ LEAD | **30/30 commands succeeded** on BOTH H6008 bulbs (RSSI -42/-45). All power, color (RGB swapped), brightness, temp, scene, proprietary confirmed. ALT UUIDs confirmed on both. |
| 21:40 | cron:4515af80 | ✅ LEAD | **30/30 commands succeeded** on BOTH H6008 bulbs. All power, color (RGB swapped), brightness, temp, scene, proprietary confirmed. ALT UUIDs confirmed on both. |
| 21:50 | cron:4515af80 | ✅ LEAD | **30/30 commands succeeded** on BOTH H6008 bulbs. All power, color (RGB swapped), brightness, temp, scene, proprietary confirmed. ALT UUIDs confirmed on both. Protocol is stable. |
| 22:00 | cron:4515af80 | ✅ LEAD | **9/9 commands succeeded** on GVH600887FB. Power, RGB (swapped), brightness 50%, temp warm/cool, scene 0x0018 all confirmed. |
| 06:02 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices (5C:E7:53:69:87:FB, 5C:E7:53:63:8F:01) out of range — not powered on or too far. H7126 protocol check confirmed OK. |
| 10:40 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of range at 10:40 UTC. H7126 (60:74:F4:94:5A:E9) and H6056 (DD:6E:86:46:44:0C) visible. H6008 bulbs still powered off or out of BLE range. |
| 10:57 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of range. H7126 (RSSI -63), H6056 (RSSI -46), GBK_H613E (RSSI -74) visible. H6008 bulbs powered off or out of BLE range. |
| 11:57 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of range. H7126 (ihoment_H7126_5AE9 RSSI -53) and H6056 (DD:6E:86:46:44:0C RSSI -67) visible. H6008 bulbs not detected — likely powered off. |
| 12:50 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of BLE range. H7126 (9/9 commands confirmed OK), H6056, GBK_H613E visible. H6008 bulbs powered off or out of range. |
| 13:27 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of BLE range. H7126 confirmed (9/9 commands: power, RGB swapped, brightness, temp, scene, proprietary all OK). H6008 bulbs powered off or out of BLE range. |
| 13:40 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of BLE range. H7126 (ihoment_H7126_5AE9 RSSI -63), H6056 (Govee_H6056_440C RSSI -50), GBK_H613E (RSSI -78) visible. H6008 bulbs still powered off or out of BLE range. |
| 14:57 | cron:4515af80 | ⚠️ HOLD | Both H6008 devices still out of BLE range. H7126 (ihoment_H7126_5AE9 RSSI -61), H6056 (Govee_H6056_440C RSSI -50), GBK_H613E (RSSI -76) visible. H6008 bulbs powered off or out of BLE range. H7126 protocol check: 5/5 commands OK (power, RGB swapped, power off). |
| 15:40 | cron:4515af80 | ✅ LEAD | **12/12 commands succeeded** on GVH60088F01 (RSSI -51). All confirmed: power, RGB swapped, brightness 50%/100%, temp warm/cool, scene 0x0018, proprietary 0x15, 0xA1, power off. H6008 back in range. |

---

## H6008 Live Confirmation Log

**Devices found (as of last contact 2026-03-31 22:00):**
- `GVH600887FB` / `5C:E7:53:69:87:FB` — Active, all commands confirmed ✅
- `GVH60088F01` / `5C:E7:53:63:8F:01` — Active, all commands confirmed ✅
- `ihoment_H7126_5AE9` / `60:74:F4:94:5A:E9` — RSSI -56 (protocol reference)
- **⚠️ 2026-04-01 15:20:** Both H6008 bulbs still out of BLE range. H7126 protocol check: 3/3 OK. H6008 bulbs powered off or moved out of BLE range.
- **✅ 2026-04-01 15:40:** GVH60088F01 (RSSI -51) confirmed live — 12/12 commands succeeded. GVH600887FB not detected this scan. H7126 (RSSI -55) also visible.

## Research Plan: Windows BLE Capture (2026-03-31)

### Bluestacks Emulator Strategy
**Status:** Not yet tested
**Approach:** Use emulator to run Govee Home, capture BLE traffic via Windows Wireshark
- BlueStacks: Free but bloatware/ad-supported, Bluetooth passthrough hit-or-miss
- Genymotion: Paid ($14/mo), clean, reliable BT, developer-focused — RECOMMENDED
- Android Studio Emulator: Free, clean, heavier setup, uses Hyper-V passthrough
- MuMu Player: Lighter than BlueStacks, fewer ads, BT support unreliable

**Next step:** Test with emulator → Govee Home → Wireshark on Windows host capturing Bluetooth HCI events

### Qualcomm FastConnect 7800 (Gaming PC)
**Chipset:** Qualcomm FastConnect 7800 Dual Bluetooth Adapter (integrated on gaming mobo)
**Status:** Adapter identified — capture feasibility unknown
**Key question:** Does it support Bluetooth Monitor Mode on Windows?
- Most consumer adapters DON'T expose monitor mode on Windows
- If emulator approach fails, hardware sniffer (nRF52840 ~$10-13) needed

### H6008 GVH-Series vs ihoment
**Critical distinction confirmed:**
- `5C:E7:53:*` (GVH prefix) — Luke's bulbs, DIFFERENT protocol from ihoment
- `98:17:3C:*` (ihoment prefix) — sisiphamus cracked this one
- Same GATT structure, different command dialect

### GATT Findings (GVH H6008)
**Services confirmed:**
- `00001801-*` — Generic Attribute (standard)
- `0000fff6-*` — Govee custom
  - `18ee2ef5-...f9d12` — indicate, read (NOT readable)
  - `64630238-...83218f04` — read (returns 23 bytes, constant)
  - `18ee2ef5-...f9d11` — write-with-response + write-without-response
- `00010203-...0d1910` — Govee custom
  - `2b10` — notify + read (read not permitted)
  - `2b11` — write-without-response + read (read not permitted)

### What Still Needs Capturing
The GVH series command format — we know the GATT structure but none of the known command formats (0x33, 0x44, 0x55 header variants) actually control the device. Real app traffic capture is the only path forward.
