# H6008 Protocol Status — BLE Blocked, Cloud v2 Working

## Device

Govee H6008 (GVH-series hardware revision). Registered in this setup as "Lamp Front" and "Lamp Top".

- **Cloud device IDs**: `82:1F:5C:E7:53:69:87:FA` (Lamp Front), `FB:7E:5C:E7:53:63:8F:00` (Lamp Top)
- **BLE addresses**: `5C:E7:53:69:87:FB` (Lamp Front, `GVH600887FB`), `5C:E7:53:63:8F:01` (Lamp Top, `GVH60088F01`)
- Single-zone bulb — no segments.

---

## Transport Verdict: Cloud v2 Works, BLE Still Blocked

| Transport | Status |
|---|---|
| Legacy v1 API (`developer-api.govee.com/v1`) | Worked for basic control; **migrated off** in favor of v2 on 2026-08-14. |
| v2 Open API (`openapi.api.govee.com/router/api/v1`) | **Works, full capability set verified against live hardware.** This is now the only supported transport. |
| BLE | **Blocked.** Undocumented protocol on this hardware revision — see [BLE Investigation](#ble-investigation-historical) below. Nothing has changed here; this section is preserved for reference. |

This is the headline change from earlier investigation: the device is no longer "blocked" in a general sense — it is **fully controllable over the cloud**, including scenes, which the bulb never had over any transport before. BLE remains unreachable and is not required.

---

## Cloud v2 API

### Migration

Migrated from Govee cloud v1 to v2 on 2026-08-14. v1 could only reach power/brightness/color/temp; v2 adds scenes, DIY scenes, and confirms what is and is not supported for this single-zone bulb.

### Endpoint & Envelope

- Base: `https://openapi.api.govee.com/router/api/v1`
- Request envelope:

```json
{
  "requestId": "<uuid>",
  "payload": { "...": "..." }
}
```

- Auth header: `Govee-API-Key`

### Capability Table

| Capability | Instance | Status | Evidence |
|---|---|---|---|
| Power | `powerSwitch` | Working | State readback confirms `1`/`0` |
| Brightness | `brightness` | Working | State readback confirms 1-100 |
| Color | `colorRgb` | Working | State readback confirms packed int |
| Color temperature | `colorTemperatureK` | Working | State readback confirms 2700-6500K |
| Firmware scenes | `lightScene` | Working (new) | 56 scenes returned by `/device/scenes`; previously unsupported over any transport |
| DIY scenes | `diyScene` | Working (new) | 2 scenes on this account: `sleep`, `FRoesy2k` |
| Segmented color | `segmentedColorRgb` | **Not supported** | HTTP/body 400 `"devices not support this instance"` |
| Segmented brightness | `segmentedBrightness` | **Not supported** | HTTP/body 400 `"devices not support this instance"` |
| Music mode | `musicMode` | **Not supported** | HTTP/body 400 `"devices not support this instance"` |
| Gradient toggle | `gradientToggle` | **Not supported** | HTTP/body 400 `"devices not support this instance"` |

The four "not supported" rejections are expected: this is a single-zone bulb, so there is nothing to segment, and it has no gradient or onboard music-reactive hardware.

### Verified Payload Shapes

#### Power

```json
{"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 1}
```
`value` is `1` or `0`.

#### Brightness

```json
{"type": "devices.capabilities.range", "instance": "brightness", "value": 50}
```
`value` is an int, 1-100.

#### Color

```json
{"type": "devices.capabilities.color_setting", "instance": "colorRgb", "value": 16711680}
```
`value` is a single packed int: `(r << 16) | (g << 8) | b`.

#### Color Temperature

```json
{"type": "devices.capabilities.color_setting", "instance": "colorTemperatureK", "value": 4000}
```
`value` is an int, range **2700-6500**. `7000` is correctly rejected client-side by govee-cli before the request is even sent.

Setting `colorTemperatureK` and `colorRgb` are mutually exclusive modes — setting one clears the other, same behavior as the H6022.

#### Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "lightScene",
  "value": {"paramId": 18595, "id": 11275}
}
```
**Both** `paramId` and `id` are required to activate a scene.

#### DIY Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "diyScene",
  "value": 22391958
}
```
`value` is a **bare int**, not an object — same gotcha as the H6022. Wrapping it (`{"value": ...}`) is rejected.

### Scenes

**56 firmware scenes** returned by `POST /device/scenes` — this is entirely new capability; the bulb previously had no scene support over any transport (v1 or BLE). Examples: Dusk, Sunset Glow, Starry Sky, Forest, River, Desert, Flower Field, Aurora, Rainbow, Karst Cave, Fire, Christmas.

**2 DIY scenes** on this account, via `POST /device/diy-scenes`: `sleep`, `FRoesy2k`.

---

## BLE address vs cloud id

This model breaks the pattern the other two follow. Verified by scan 2026-08-14:

| Device | Cloud id | Advertises |
|---|---|---|
| Lamp Front | `82:1F:5C:E7:53:69:87:FA` | `5C:E7:53:69:87:FB` |
| Lamp Top | `FB:7E:5C:E7:53:63:8F:00` | `5C:E7:53:63:8F:01` |

The BLE address is the cloud id's last six octets **+1 on the final byte**, where
the H6056 and H6022 are the last six octets exactly. `govee-cli` derives last-6
and does not special-case this, because the BLE command protocol below is
non-functional on this revision anyway; `static_mac` in the config is the escape
hatch if an exact address is ever needed.

## BLE Investigation (historical)

Everything below predates the cloud v2 migration and remains accurate for BLE. It is preserved because the underlying hardware and blockers have not changed — BLE access to the GVH-series H6008 is still not possible.

### Two Different Hardware Revisions

There are two distinct H6008 hardware variants with incompatible protocols:

| | Old (works) | New (blocked) |
|---|---|---|
| BLE name prefix | `ihoment_H6008_XXXX` | `GVH6008XXXX` |
| OUI | `98:17:3C` (Govee) | `5C:E7:53` (HOMY IOT SOLUTIONS) |
| Company ID | `0x88EC` | `0x8843` |
| Protocol | `0x33`-header, documented | Unknown, undocumented |
| Community support | Yes (sisiphamus, hardcpp) | None |

**The devices in this repo are the GVH-series (new hardware).** Everything below applies to them.

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

### What Has Been Ruled Out

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

### fff6 Service Notes

The `18ee2ef5` UUIDs match the Matter CHIPoBLE spec (C1/C2 characteristics). However:
- No Matter service data in the advertisement (a device in commissioning mode would advertise UUID `0xFFF6`)
- BTP handshake gets no response
- These characteristics likely exist in the firmware but are dormant (device already commissioned, or Govee uses them differently)

The `64630238` characteristic returns 23 bytes that resemble Matter TLV (Rotating Device ID format), but its role in the control protocol is unknown.

### BLE Status: Still Blocked

The GVH-series H6008 uses an undocumented BLE protocol. No public reverse engineering project has cracked it. The only confirmed BLE controller is the Govee iOS app. **This no longer matters for day-to-day control** — cloud v2 covers everything the app can do, including scenes BLE never had. BLE would only be worth revisiting for use cases that specifically need it (e.g. offline control, or higher frame-rate effects than the cloud budget allows, as is the case for the H6056).

### Paths Forward for BLE (if ever revisited)

**Option 1: Passive BLE Sniffer (recommended)**
An **nRF52840 USB dongle** (~$10-15) flashed with Nordic Semiconductor's Bluetooth Sniffer firmware can passively capture the iPhone↔bulb BLE traffic without connecting. This would reveal the exact bytes the Govee app sends. Wireshark reads the output natively.

Steps once obtained:
1. Flash Nordic Sniffer firmware (free from Nordic)
2. Open Wireshark, select the sniffer interface
3. Use Govee app to control bulb while capturing
4. Filter by device MAC, look for ATT Write Command/Request PDUs

**Option 2: iOS Bluetooth Logging (free, annoying)**
1. Install Bluetooth Logging profile from `developer.apple.com/bug-reporting/profiles-and-logs/`
2. Restart iPhone
3. Control bulb with Govee app
4. Wait ~20 minutes, then check Settings → Privacy & Security → Analytics & Improvements → Analytics Data for a `sysdiag-*.tar.gz` file
5. Open the `.pklg` inside in Wireshark

**Option 3: WiFi + LAN API (requires own network)**
Provision bulbs to a WPA2-Personal WiFi network (not eduroam), then control via the Govee LAN API (UDP port 4003, local only — H6008 LAN support unconfirmed). Now largely moot since cloud v2 already works.

---

## Gotchas

- **DIY scene value is a bare int, not an object**, same as the H6022 and unlike `lightScene` (which needs `{"paramId": ..., "id": ...}`).
- **`segmentedColorRgb`, `segmentedBrightness`, `musicMode`, `gradientToggle` all 400** with `"devices not support this instance"` — expected for a single-zone bulb with no gradient/music hardware, not a bug.
- **Colour temp range is 2700-6500K** — govee-cli correctly rejects 7000K client-side; don't assume the H6022/H6056 range (2000-9000K) applies here.
- **`colorTemperatureK` and `colorRgb` are mutually exclusive** — setting one clears the other.
- **Cloud device IDs are not BLE addresses.** `82:1F:5C:E7:53:69:87:FA` and `FB:7E:5C:E7:53:63:8F:00` are 8-octet cloud IDs; the actual BLE MACs are the 6-octet `5C:E7:53:69:87:FB` / `5C:E7:53:63:8F:01`. This mirrors the same trap documented for the H6056.
- **BLE remains blocked regardless of cloud success** — do not assume cloud v2 working means the BLE protocol got solved. It didn't; it's just no longer necessary.

---

*Verified against live hardware: 2026-08-14.*
*Devices: Lamp Front (`82:1F:5C:E7:53:69:87:FA` cloud / `5C:E7:53:69:87:FB` BLE), Lamp Top (`FB:7E:5C:E7:53:63:8F:00` cloud / `5C:E7:53:63:8F:01` BLE).*
