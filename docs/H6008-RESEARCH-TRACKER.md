# H6008 Research Tracker

**Last updated:** 2026-03-31 02:41
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
The live test couldn't find the H6008 (`5C:E7:53:69:87:FB`). Was the bulb powered off or out of Bluetooth range?

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
