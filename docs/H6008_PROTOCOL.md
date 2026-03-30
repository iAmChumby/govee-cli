# H6008 BLE Protocol — Reverse Engineering Status

## Two Different Hardware Revisions

There are two distinct H6008 hardware variants with incompatible protocols:

| | Old (works) | New (blocked) |
|---|---|---|
| BLE name prefix | `ihoment_H6008_XXXX` | `GVH6008XXXX` |
| OUI | `98:17:3C` (Govee) | `5C:E7:53` (HOMY IOT SOLUTIONS) |
| Company ID | `0x88EC` | `0x8843` |
| Protocol | `0x33`-header, documented | Unknown, undocumented |
| Community support | Yes (sisiphamus, hardcpp) | None |

**The devices in this repo are the GVH-series (new hardware). Everything below applies to them.**

---

## What Has Been Confirmed

### GATT Layout (via bleak discovery)

```
Service: 0000fff6-0000-1000-8000-00805f9b34fb
  18ee2ef5-263d-4559-959f-4f9c429f9d11  handle 0x000D  write-without-response, write
  64630238-8772-45f2-b87d-748a83218f04  handle 0x0012  read → value: 153000120700bdcb874d21247b54226f38b4f6b55afd18
  18ee2ef5-263d-4559-959f-4f9c429f9d12  handle 0x000F  read, indicate

Service: 00010203-0405-0607-0809-0a0b0c0d1910
  00010203-0405-0607-0809-0a0b0c0d2b11  handle 0x0018  read, write-without-response
  00010203-0405-0607-0809-0a0b0c0d2b10  handle 0x0015  read, notify

Service: 00001801-0000-1000-8000-00805f9b34fb
  00002a05-0000-1000-8000-00805f9b34fb  handle 0x0002  indicate
```

### BLE Advertisement

- **No service UUIDs advertised** — only manufacturer data
- Manufacturer ID: `0x8843` (HOMY IOT SOLUTIONS)
- Manufacturer data: `ec 00 01 01 01 00` (6 bytes, constant — does not change when state changes)
- Advertisement continues even while the Govee app is controlling the device (quick connect/disconnect cycles)

### Control Channel

- Govee iOS app controls these bulbs via **BLE** (confirmed: iPhone WiFi disabled, app still works)
- The app is NOT holding a persistent connection — device keeps advertising throughout
- No WiFi needed for app control

---

## What Has Been Ruled Out

| Approach | Result |
|---|---|
| `0x33` commands on `00010203...2b11` | Writes accepted, bulb ignores them |
| `0x33` commands on `18ee2ef5...9d11` | Writes accepted, bulb ignores them |
| Matter BTP handshake (`65 6c 04 f4 00 04 00 00 00`) `response=False` | No C2 indication |
| Matter BTP handshake `response=True` | Write accepted, no C2 indication |
| Standard BLE pairing via `bluetoothctl pair` | `AuthenticationFailed` |
| nRF Connect iOS app with `0x33` power-off packet | No response |
| iOS Govee app + passive Linux scan | Advertisement never changes |

### Why Capture Is Blocked

- **`btmon`**: crashes immediately on startup with `*** buffer overflow detected ***: terminated` (SIGABRT from glibc stack protector, BlueZ 5.72 bug, building 5.75 from source did not fix it)
- **`hcidump`**: works but only captures Linux's own HCI traffic (`hci0`), not the iPhone's radio
- **Single-connection BLE limit**: can't subscribe to notifications while the Govee app is connected — the device is only connectable by one central at a time

---

## fff6 Service Notes

The `18ee2ef5` UUIDs match the Matter CHIPoBLE spec (C1/C2 characteristics). However:
- No Matter service data in the advertisement (a device in commissioning mode would advertise UUID `0xFFF6`)
- BTP handshake gets no response
- These characteristics likely exist in the firmware but are dormant (device already commissioned, or Govee uses them differently)

The `64630238` characteristic returns 23 bytes that resemble Matter TLV (Rotating Device ID format), but its role in the control protocol is unknown.

---

## Current Status

**Blocked.** The GVH-series H6008 uses an undocumented BLE protocol. No public reverse engineering project has cracked it. The only confirmed working controller is the Govee iOS app.

---

## Paths Forward

### Option 1: Passive BLE Sniffer (recommended)
An **nRF52840 USB dongle** (~$10-15) flashed with Nordic Semiconductor's Bluetooth Sniffer firmware can passively capture the iPhone↔bulb BLE traffic without connecting. This would reveal the exact bytes the Govee app sends. Wireshark reads the output natively.

Steps once obtained:
1. Flash Nordic Sniffer firmware (free from Nordic)
2. Open Wireshark, select the sniffer interface
3. Use Govee app to control bulb while capturing
4. Filter by device MAC, look for ATT Write Command/Request PDUs

### Option 2: iOS Bluetooth Logging (free, annoying)
1. Install Bluetooth Logging profile from `developer.apple.com/bug-reporting/profiles-and-logs/`
2. Restart iPhone
3. Control bulb with Govee app
4. Wait ~20 minutes, then check Settings → Privacy & Security → Analytics & Improvements → Analytics Data for a `sysdiag-*.tar.gz` file
5. Open the `.pklg` inside in Wireshark

### Option 3: WiFi + API (requires own network)
Provision bulbs to a WPA2-Personal WiFi network (not eduroam), then control via:
- **Govee Cloud API** (requires API key from Govee app, internet on device)
- **Govee LAN API** (UDP port 4003, local only — H6008 LAN support unconfirmed)

Requires a dedicated AP/router or travel router — eduroam (WPA2-Enterprise) is incompatible with IoT devices.

---

*Last updated: 2026-03-30*
*Devices: GVH600887FB (`5C:E7:53:69:87:FB`), GVH60088F01 (`5C:E7:53:63:8F:01`)*
