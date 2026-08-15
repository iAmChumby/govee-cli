# H6056 Protocol Status — Dual Transport (BLE + Cloud v2)

## Device

Govee H6056 "Flow Plus Light Bars". Registered in this setup as "Light Bars".

- **Cloud device ID** (Govee 8-octet cloud ID): `6D:19:DD:6E:86:46:44:0C`
- **BLE address**: `DD:6E:86:46:44:0C` — the last 6 octets of the cloud ID, confirmed via `bluetoothctl devices` showing `DD:6E:86:46:44:0C Govee_H6056_440C`.
- **Sticker/static MAC**: `D0:C9:07:FE:B6:F0` (used for config; see main `CLAUDE.md` — this is the value the BLE stack ultimately connects through in this repo's config).
- 2 physical light bars, 6 BLE segments total (3 per bar).

---


> **The last-6-octets rule is model-specific, not universal.** Verified by scan
> 2026-08-14: it holds for the H6056 (`6D:19:...:44:0C` → `DD:6E:86:46:44:0C`)
> and the H6022 (`50:CE:...:50:3F` → `E8:6E:80:C6:50:3F`), but the GVH-series
> H6008 advertises the last six octets **+1 on the final byte**
> (cloud `...69:87:FA` → BLE `...69:87:FB`). Don't generalise it.


## Transport Verdict: Dual Transport, Different Jobs

| Transport | Status | Use case |
|---|---|---|
| BLE (`0x33` protocol) | Working, documented | Keyframe effects — needed for full frame rate |
| Legacy v1 API | Worked for power/brightness/color/temp only | Superseded, migrated off 2026-08-14 |
| Cloud v2 API | Working, full capability set verified against live hardware | Everything else: scenes, DIY, segments, music, gradient |

Neither transport alone covers everything this device can do. govee-cli uses **BLE for keyframe effects** (cloud playback is capped at 2fps by the request budget; BLE runs at full frame rate) and **cloud v2 for everything else** (scenes, DIY scenes, segmented color/brightness, music mode, gradient toggle — none of which v1 could reach).

---

## BLE — `0x33` Protocol

- Service: `00010203-0405-0607-0809-0a0b0c0d1910`
- Write characteristic: `00010203-0405-0607-0809-0a0b0c0d2b11`
- Notify characteristic: `00010203-0405-0607-0809-0a0b0c0d2b10`
- Packet format: 20 bytes — `[0x33][cmd][payload padded to 18 bytes][XOR checksum]`
- Addresses **6 segments** (indices 0-5) — a different count from the cloud path's segment bound (see [Gotchas](#gotchas)).
- Preferred for keyframe effects: cloud playback is capped at 2fps by the request budget, while BLE runs at full frame rate. Anything with fast-changing per-frame color belongs on BLE.

**Connection gotcha**: the cloud device ID (`6D:19:DD:6E:86:46:44:0C`, 8 octets) is not a usable BLE address. The BLE stack needs the 6-octet address `DD:6E:86:46:44:0C` — the last 6 octets of the cloud ID — confirmed by `bluetoothctl devices` listing it as `Govee_H6056_440C`. Handing the 8-octet cloud ID to a BLE stack can never connect.

---

## Cloud v2 API

### Migration

Migrated from v1 to v2 on 2026-08-14. v1 could only carry power/brightness/color/temp, which left scenes, DIY, segments, music, and gradient entirely unreachable over cloud. All four v1-era capabilities were re-verified over v2 with state readback before the migration was considered complete.

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
| Power | `powerSwitch` | Working | State readback |
| Brightness | `brightness` | Working | State readback |
| Color | `colorRgb` | Working | State readback |
| Color temperature | `colorTemperatureK` | Working | State readback, range 2000-9000K |
| Firmware scenes | `lightScene` | Working | 69 scenes returned by `/device/scenes`; readback always `""` |
| DIY scenes | `diyScene` | Working | 4 scenes on this account; readback always `""` |
| Segmented color | `segmentedColorRgb` | Working, bounded 0-14 | Index 15 rejected 400 "Parameter value out of range" |
| Segmented brightness | `segmentedBrightness` | **Working** (unlike H6022) | `{"segment": [0,1], "brightness": 30}` accepted |
| Music mode | `musicMode` | Working, 8 modes | Model-specific integer table, see below |
| Gradient toggle | `gradientToggle` | Working | On/off verified |
| DreamView toggle | `dreamViewToggle` | **Advertised, but rejected** | 400 "The device does not has DreamView" |

### Verified Payload Shapes

#### Power

```json
{"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 1}
```

#### Brightness

```json
{"type": "devices.capabilities.range", "instance": "brightness", "value": 50}
```

#### Color

```json
{"type": "devices.capabilities.color_setting", "instance": "colorRgb", "value": 16711680}
```
`value` is a single packed int: `(r << 16) | (g << 8) | b`.

#### Color Temperature

```json
{"type": "devices.capabilities.color_setting", "instance": "colorTemperatureK", "value": 4000}
```
Range **2000-9000K**.

#### Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "lightScene",
  "value": {"paramId": 18595, "id": 11275}
}
```
Both `paramId` and `id` required.

#### DIY Scene

```json
{
  "type": "devices.capabilities.dynamic_scene",
  "instance": "diyScene",
  "value": 22391958
}
```
`value` is a **bare int**, not an object.

#### Segmented Color

```json
{
  "type": "devices.capabilities.segment_color_setting",
  "instance": "segmentedColorRgb",
  "value": {"segment": [0, 1, 2], "rgb": 16711680}
}
```
Accepted for indices 0-14. Index 15 rejected with 400 "Parameter value out of range".

#### Segmented Brightness

```json
{
  "type": "devices.capabilities.segment_brightness",
  "instance": "segmentedBrightness",
  "value": {"segment": [0, 1], "brightness": 30}
}
```
Works on this model. The H6022 rejects this same instance with 400 `"devices not support this instance"` — do not assume segmented brightness support is uniform across models.

#### Music

```json
{
  "type": "devices.capabilities.music_setting",
  "instance": "musicMode",
  "value": {
    "musicMode": 2,
    "sensitivity": 50,
    "autoColor": 1,
    "rgb": 16711680
  }
}
```

#### Gradient Toggle

```json
{"type": "devices.capabilities.toggle", "instance": "gradientToggle", "value": 1}
```
Verified working, `1`/`0`.

#### DreamView Toggle (rejected)

```json
{"type": "devices.capabilities.toggle", "instance": "dreamViewToggle", "value": 1}
```
Returns HTTP/body 400 `"The device does not has DreamView"` — advertised in the device's capability list but non-functional on this hardware.

---

## Scenes

- **69 firmware scenes** returned by `/device/scenes`. v1 had none over cloud; the BLE built-in table has only 27, several of which need an unreversed multi-packet protocol to trigger. Examples: Aurora, Snow flake, Seasonal, Stream, Rainbow, Meteor, Fire, Bloom, Glacier, Deep sea, Cornfield, Grassland, Romantic, Soothing, Clear Sky, Tenderness, Mild, Meditation.
- **4 DIY scenes** on this account: `sleep`, `Gaming`, `make a calming, purple`, `FRoesy2k`.

---

## Music Modes (model-specific)

H6056 advertises 8 modes:

| Value | Mode |
|---|---|
| 0 | Vivid |
| 1 | Strike |
| 2 | Rhythm |
| 3 | Vibrate |
| 4 | Beat |
| 5 | Torch |
| 6 | RainbowCircle |
| 7 | Shiny |

**These integers are not portable to other models.** The H6022 advertises a different set: Rhythm=3, Rolling=4, Energic=5, Spectrum=6. Note that H6056's Rhythm=2 and H6022's Rhythm=3 are the same-named mode with different integers on each model. A mix-up doesn't error — it silently sets the wrong mode. Always look up the mode table per model before sending `musicMode`.

---

## State Reporting

`POST /device/state` reliably reports: `online`, `powerSwitch`, `brightness`, `colorRgb`, `colorTemperatureK`.

It always returns an **empty string `""`** for: `lightScene`, `segmentedColorRgb`, `segmentedBrightness`, `musicMode`, `diyScene`, `snapshot`, `gradientToggle`, `dreamViewToggle`. None of these can be confirmed by state readback — an empty value is not evidence of a failed command, only that this device doesn't report those instances back. Confirm visually or by other means when testing them.

---

## Gotchas

- **8-octet cloud ID vs 6-octet BLE address.** The cloud device ID `6D:19:DD:6E:86:46:44:0C` is 8 octets; BLE needs the last 6, `DD:6E:86:46:44:0C`. Handing the cloud ID straight to a BLE stack can never connect — confirmed via `bluetoothctl devices` (`Govee_H6056_440C`). The sticker/static MAC `D0:C9:07:FE:B6:F0` is a separate value, documented elsewhere in this repo.
- **`dreamViewToggle` is advertised but non-functional.** The API lists it as a capability, but the hardware rejects it with 400 "The device does not has DreamView". The advertised capability list is a starting point for probing, never a guarantee — verify each instance against real hardware before trusting it.
- **Music mode integers are model-specific.** H6056's 0-7 table does not match the H6022's 3-6 table, even for identically-named modes (e.g. "Rhythm" is 2 here, 3 there). Wrong integer = wrong mode set silently, not an error.
- **Segment count discrepancy between transports.** Cloud API accepts segment indices 0-14 (15 rejected); BLE addresses only 6 segments (0-5), matching the documented physical layout of 6 zones (2 bars × 3). The API accepting an index up to 14 is not proof the hardware has that many physical zones — govee-cli uses the cloud-reported bound (0-14) for the cloud path and 6 for BLE, and these are intentionally not reconciled into one number.
- **State endpoint reports `""` for scene/segment/music/gradient/dreamView.** Do not treat an empty value from `/device/state` as a failure signal for these instances.
- **BLE keyframe effects are capped at cloud's 2fps** if mistakenly routed through the cloud path — use BLE for anything frame-rate sensitive.

---

*Verified against live hardware: 2026-08-14.*
*Device: Light Bars, H6056, `6D:19:DD:6E:86:46:44:0C` (cloud) / `DD:6E:86:46:44:0C` (BLE).*
