# H6008 Bulb — Reverse Engineering Status

**Last updated:** 2026-03-30
**Context:** Worked all day (2026-03-30) — see `govee-bulb-issues.md` for full debugging session log

---

## Current Status

| Device | Model | Working? | Notes |
|--------|-------|----------|-------|
| Light bars | H6056 | ✅ YES | Full support — power, color, brightness, temp, scene, DIY effect, segments |
| Bulbs (new) | H6008 GVH-series | ❌ NO | All `0x33` commands ignored — different protocol |

**The H6008 GVH-series bulbs (MAC: `5C:E7:53:69:87:FB`, name: `ihoment`) do not respond to ANY `0x33` BLE command.**

---

## What We Know

### H6008 GVH-series GATT Structure

The GVH-series bulbs expose the **standard Govee GATT UUIDs** — the same service/char UUIDs as the H6056:

```
Service: 0000fff3-0000-1000-8000-00805f9b34fb
  Char: 0000fff4-0000-1000-8000-00805f9b34fb (write, no response)
  Char: 0000fff5-0000-1000-8000-00805f9b34fb (read/notify)
```

So the GATT layer is identical to H6056. The issue is in the application protocol.

### Packet Format — What We Tried

**Power command (same as H6056):**
```
33 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 32
```
- Byte 0: 0x33 (header)
- Byte 1: 0x01 (power command)
- Bytes 2–18: payload + zero padding
- Byte 19: XOR checksum (0x33 ^ 0x01 ^ 0x00 = 0x32) ✅ Verified correct

**Color command (from sisiphamus/govee-controller — should work on H6008):**
```
33 05 02 [R] [G] [B] 00 00 00 00 00 00 00 00 00 00 00 00 [CHECKSUM]
```
- Mode byte: 0x02 (MODE_2 — simpler than H6056's MODE_1501)

**Temperature command (from sisiphamus):**
```
33 05 02 FF FF FF 01 [K_hi] [K_lo] [zeros] [CHECKSUM]
```
- 0x01 = CCT flag byte

All packets are accepted by the BLE GATT layer (no error returned), but the bulbs do not respond.

---

## The `group.py` Bug (Already Fixed)

The inline command parser in `group.py` was using H6056 MODE_1501 format for all devices. This has been fixed — it now uses `encode_color_hex_for_device()` and `encode_temp_for_device()` which pick the right format per device model.

**This fix does not help the H6008** because the `0x33` commands in any format are ignored by the GVH-series bulbs entirely.

---

## What Might Be Wrong

### Theory 1: GVH-series uses a different protocol entirely
The `GVH` prefix on the MAC/adv name might indicate new hardware with a different BLE protocol. The H6056 protocol (`0x33`) may be retired/deprecated on this hardware revision. The standard GATT UUIDs might be decoys — present but non-functional.

### Theory 2: Pairing / bonding required
The H6056 works without pairing. Maybe the GVH-series requires BLE bonding/SMP pairing before accepting commands, which `bleak` doesn't do automatically.

### Theory 3: Different write characteristic
The bulbs expose both fff3/fff4 (standard) AND a separate service with different UUIDs. Maybe commands should go to a different characteristic.

### Theory 4: BLE connection timing
The H6008 requires a delay between connecting and receiving commands. H6056 works with immediate write; GVH-series might need `await asyncio.sleep(0.1)` after connection.

---

## What to Try Next

### Option A: nRF52840 Sniffer (Recommended)
Passive BLE capture without btmon. Nordic nRF52840 dongle with sniffer firmware (~($10-15).

```
1. Buy nRF52840 dongle (e.g., nRF52840-DK or BDK-ANSI)
2. Flash sniffer firmware: https://infocenter.nordicsemi.com/index.jsp?topic=%2Fsniffer_ug%2Fsniffer_ug_intro.html
3. Run Wireshark with nRF sniffer plugin
4. Use Govee app to control bulb → capture actual protocol bytes
```

This captures exactly what the official app sends, revealing the real protocol.

### Option B: iOS Bluetooth Logging
Generate a sysdiag tar.gz from iOS Bluetooth logging and extract HCI snoop data.

### Option C: WiFi / LAN API
If the H6008 supports WiFi (many Govee bulbs do), connect it to the LAN and use Govee's LAN API protocol instead of BLE. Requires different network.

### Option D: Govee Matter/CHIPoBLE
The H6008 exposes a Matter service. Could be using CHIPoBLE for commands instead of the standard Govee BLE protocol.

### Option E: Try longer connection delay
In `ble/gatt.py`, add a delay after connecting:
```python
await asyncio.sleep(0.2)  # before first write
```

---

## Key Files

| File | Purpose |
|------|---------|
| `govee_cli/devices/h6008.py` | H6008 device definition (MODE_2, 1 segment) |
| `govee_cli/ble/protocol.py` | Protocol encoding functions (`encode_color_simple`, `encode_temp_simple`) |
| `govee_cli/ble/gatt.py` | BLE connection handling |
| `govee_cli/commands/group.py` | Group command (fixed to use per-device format) |
| `docs/H6008_PROTOCOL.md` | Protocol research from sisiphamus/govee-controller |
| `govee-bulb-issues.md` | Full debugging session log |
| `govee_cli/ble/discover.py` | GATT service discovery script |

---

## Reference Sources

- **sisiphamus/govee-controller** — Python implementation with H6008 support, MODE_2 protocol reference
- **egold555/Govee-Reverse-Engineering** — H6053, H6127, H6072 product docs (H6008 not covered)
- **wez/govee-py** — Reference Python implementation (H6056 family)
