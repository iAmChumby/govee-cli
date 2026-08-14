# H6022 Protocol Status — Cloud v2 API

## Device

Govee H6022 "RGBIC Table Lamp 2" (shelf lamp). Registered in this setup as "Shelf Lamp".

- **Device ID** (Govee 8-octet cloud ID): `50:CE:E8:6E:80:C6:50:3F`
- WiFi 2.4GHz + Bluetooth hybrid — architecturally unlike the BLE-only H6056 light bars in this repo.

---

## Transport Verdict: Cloud v2 Only

| Transport | Status |
|---|---|
| Legacy v1 API (`developer-api.govee.com/v1/devices`) | **Device does not appear at all.** Any v1-based code path cannot see or control it. |
| v2 Open API (`openapi.api.govee.com/router/api/v1`) | Works, full capability set. |
| BLE | No published reverse engineering exists (see below). Unconfirmed. |
| LAN API | Advertised capable, but hazardous — see [LAN Control warning](#lan-api-hazard-do-not-enable) below. |

This is the single most important fact about this device: **use v2, not v1.**

### BLE — searched, nothing found

No community reverse engineering exists for the H6022 anywhere. Searched:

- egold555/Govee-Reverse-Engineering
- wez/govee-py
- wez/govee2mqtt
- Bluetooth-Devices/govee-ble
- chvolkmann/govee_btled
- Beshelmek/govee_ble_lights
- sisiphamus/govee-controller
- the H6127/H6199/H6054 reverse-engineering repos

None mention H6022. The classic `[0x33][cmd][payload][XOR]` protocol used by the H6056/H6008 is **not confirmed to apply** here. Getting BLE support would require an original capture (nRF52840 sniffer) — `btmon` is broken on this host and BLE's single-connection limit prevents passive monitoring while another client (e.g. the phone app) is connected. See `docs/H6008_PROTOCOL.md` for the same capture blockers in more detail; they apply identically here.

### LAN API — hazard, do not enable

The H6022 is listed in Home Assistant's `govee_light_local` supported models, and Govee's own device metadata flags it `lan_api_capable: true`. **However**, there is an open, unresolved upstream bug — [wez/govee2mqtt#518](https://github.com/wez/govee2mqtt/issues/518) — reporting that enabling LAN Control on an H6022 makes the lamp **completely unresponsive, including to its own physical buttons**, until LAN Control is switched back off in the Govee app.

LAN control was deliberately **not** enabled on this device. Do not enable it without a plan to recover (the fix is reportedly toggling LAN Control back off in-app, but that requires the lamp to still be reachable to do so).

---

## v2 API Endpoints Used

| Endpoint | Purpose |
|---|---|
| `GET  /user/devices` | Device list with capabilities |
| `POST /device/state` | Current state |
| `POST /device/control` | Send a capability command |
| `POST /device/scenes` | Firmware scene library |
| `POST /device/diy-scenes` | User DIY scenes |

Request envelope:

```json
{
  "requestId": "<uuid>",
  "payload": { "...": "..." }
}
```

Auth header: `Govee-API-Key`.

**Confirmed not to exist:** `/device/snapshots` and its plausible variants all 404. Tried: `/device/snapshots`, `/device/snapshot`, `/device/device-snapshots`. There is no snapshot-listing endpoint (see [Scenes](#scenes) below).

---

## Capabilities Advertised

`powerSwitch`, `brightness`, `colorRgb`, `colorTemperatureK`, `segmentedColorRgb`, `lightScene`, `musicMode`, `diyScene`, `snapshot`.

**Not supported:** `segmentedBrightness` — returns HTTP/body code 400 `"devices not support this instance"`. This is useful as a control: it proves the API distinguishes supported from unsupported instances, so a 200 response on the other capabilities is meaningful and not just an API no-op.

---

## Verified Payload Shapes

Each `capability` object has the shape `{"type": ..., "instance": ..., "value": ...}`.

### Power

```json
{"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 1}
```
`value` is `1` or `0`.

### Brightness

```json
{"type": "devices.capabilities.range", "instance": "brightness", "value": 50}
```
`value` is an int, 1-100.

### Color

```json
{"type": "devices.capabilities.color_setting", "instance": "colorRgb", "value": 16711680}
```
`value` is a single packed int: `(r << 16) | (g << 8) | b`.

### Color Temperature

```json
{"type": "devices.capabilities.color_setting", "instance": "colorTemperatureK", "value": 4000}
```
`value` is an int, range 2700-6500.

### Segments

```json
{
  "type": "devices.capabilities.segment_color_setting",
  "instance": "segmentedColorRgb",
  "value": {"segment": [0, 1, 2], "rgb": 16711680}
}
```
`segment` is an **array** — many segments can be set to the same color in one request.

### Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "lightScene",
  "value": {"paramId": 18595, "id": 11275}
}
```
**Both** `paramId` and `id` are required.

### DIY Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "diyScene",
  "value": 22391958
}
```
`value` is a **bare int**, not an object. The wrapped form `{"value": 22391958}` is rejected with `"Missing relevant parameters: id"`. See [Gotchas](#gotchas).

### Music

```json
{
  "type": "devices.capabilities.music_setting",
  "instance": "musicMode",
  "value": {
    "musicMode": 3,
    "sensitivity": 50,
    "autoColor": 1,
    "rgb": 16711680
  }
}
```
`sensitivity` is 0-100. `autoColor` and `rgb` are optional.

---

## Segments

- **15 addressable zones**, indices 0-14. All 15 accepted (HTTP 200).
- Index 15 rejected: code 400 `"Parameter value out of range"`.
- Visually confirmed on hardware: setting segments 0-6 red and 7-14 blue produced two distinct color zones on the physical lamp. Per-segment addressing genuinely works — it is not collapsed to a single whole-lamp color under the hood.

---

## Music Modes (model-specific)

H6022 advertises exactly four modes:

| Value | Mode |
|---|---|
| 3 | Rhythm |
| 4 | Rolling |
| 5 | Energic |
| 6 | Spectrum |

**These integers are not portable to other models.** The H6056 advertises a completely different set: Vivid=0, Strike=1, Rhythm=2, Vibrate=3, Beat=4, Torch=5, RainbowCircle=6, Shiny=7. Note in particular that H6056's Rhythm=2 and H6022's Rhythm=3 are the same-named mode with different integers. Any code that hardcodes a music mode number must key it to the model, not assume a shared enum.

The device does its own audio pickup via its onboard microphone; no audio is streamed from the host.

---

## Scenes

- **94 firmware scenes** returned by `/device/scenes` (Sunrise, Sunset, Rainbow, Aurora, Forest, Ocean, Snow flake, Fire, Christmas variants, and more). Each carries a `paramId` and an `id` — both required to activate it (see [Scene payload](#scene) above).
- **2 DIY scenes** on this account at time of writing: `sleep`, `FRoesy2k`.
- **Snapshots:** none saved. The `snapshot` capability's options array is empty, and there is no listing endpoint (confirmed above), so a snapshot can only be triggered by a raw numeric id obtained some other way (e.g. from the Govee app).

---

## State Reporting — Important Limitation

`POST /device/state` reliably reports: `online`, `powerSwitch`, `brightness`, `colorRgb`, `colorTemperatureK`.

It **lists** `segmentedColorRgb`, `lightScene`, `musicMode`, `diyScene`, and `snapshot` as instances, but **always returns an empty string `""`** for their values — the device does not report these back through the state endpoint. An empty scene/segment/music value is therefore **not evidence of a failed command**; those changes can only be confirmed visually.

Also: setting `colorTemperatureK` zeroes the reported `colorRgb`, and vice versa — the two are mutually exclusive modes on this device, not independent fields.

---

## Rate Limiting

Measured: 12 consecutive control requests at a 1.0s gap, and 12 more at a 0.5s gap, produced zero 429s. Typical response latency 0.15-0.24s. No `X-RateLimit-*` headers are returned in responses.

The binding constraint appears to be the documented per-account daily request budget rather than short-term throughput, so sustained animation should stay at low frame rates rather than push short-interval bursts. govee-cli caps cloud effect playback at 2fps (default 1fps) and batches same-colored segments into a single request.

---

## Gotchas

- **DIY scene value is a bare int, not an object.** `{"type": "devices.capabilities.dynamic_scene", "instance": "diyScene", "value": 22391958}` works; wrapping the id as `{"value": 22391958}` fails with `"Missing relevant parameters: id"`. This is inconsistent with the `lightScene` instance, which does expect an object (`{"paramId": ..., "id": ...}`).
- **State endpoint reports empty strings for scene/segment/music/snapshot.** Do not treat `""` from `/device/state` as a failure signal for these instances — verify visually instead.
- **The device is invisible to the v1 API entirely.** Any code path assuming v1 coverage of all registered devices will silently skip the H6022.
- **Music mode integers are model-specific.** H6022's 3-6 do not mean the same thing as another model's 3-6 (or even the same-named mode at a different H6056 integer). Always look up the mode table per model.
- **Do not enable LAN Control on this device.** Per [wez/govee2mqtt#518](https://github.com/wez/govee2mqtt/issues/518), it has been reported to make the lamp fully unresponsive, including to physical buttons, until switched back off.

---

*Verified against live hardware: 2026-08-14.*
*Device: Shelf Lamp, H6022, `50:CE:E8:6E:80:C6:50:3F`.*
