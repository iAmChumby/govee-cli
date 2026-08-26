# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Development Commands

```bash
# Run all tests
pytest

# Run a single test file
pytest tests/test_protocol.py

# Run a single test class or function
pytest tests/test_protocol.py::TestBuildPacket::test_packet_structure

# Type check
mypy govee_cli

# Lint
ruff check govee_cli

# Auto-fix lint issues
ruff check --fix govee_cli
```

## Architecture

The stack is: **CLI → Commands → transport routing → (cloud v1 | cloud v2 | BLE) → Device**

### Transports — read this first

Three transports are in play, and which one carries a command depends on the
**model**, not the command:

| Transport | Endpoint | Used by | Reaches |
|---|---|---|---|
| `cloud-v2` | `openapi.api.govee.com/router/api/v1` | H6022, H6056, H6008 | everything: power/brightness/color/temp/state **plus** scenes, DIY, segments, music, toggles |
| `cloud-v1` | `developer-api.govee.com/v1` | H6183 only | power, brightness, color, temp, state |
| `ble` | direct GATT | H6056 keyframe effects; anything unregistered | 0x33 packet protocol |

**The v1 API does not list every device, and carries only four commands.** The
H6022 is invisible to it entirely; the H6056 and H6008 were migrated off it on
2026-08-14 because it could not reach their scenes, segments or music. Only the
H6183 remains on v1, and only because there is no hardware here to verify a move
against. `scan-http` discovers over v2.

**BLE is not dead** — it is still the best path for keyframe effects on the
H6056, because cloud playback is capped at 2fps by the request budget while BLE
runs at full frame rate. `ModelSpec.prefer_ble_effects` encodes that.

Routing lives in **`govee_cli/transport.py`** — one `ModelSpec` per model. Adding
a model means adding a spec there and a handler in `devices/`, not editing every
command file.

### Key layers

- **`govee_cli/cli.py`** — Click root group. Loads config on every invocation, injects `default_mac`, `default_adapter`, `default_timeout` into `ctx.obj`. All commands are registered here via `main.add_command()`.

- **`govee_cli/transport.py`** — `MODEL_SPECS` (segment count, temp range, per-model cloud feature flags) and `resolve_target()`. The single source of truth for which transport reaches which model.

- **`govee_cli/http_v2.py`** — Govee Open API v2 client. Capability-based (`{type, instance, value}`), retries with backoff on 429/5xx, caches the firmware scene library on disk for 7 days.

- **`govee_cli/http.py`** — Legacy v1 client. Still the path for H6056/H6008/H6183; do not migrate them without re-verifying against hardware.

- **`govee_cli/config.py`** — Config dataclass backed by `~/.config/govee-cli/config.json`. Holds default MAC, adapter, timeout, brightness, color, and device groups (`{group_name: [mac, ...]}`).

- **`govee_cli/commands/`** — One file per command. Each exports a `command` (or group) object that gets registered in `cli.py`. Commands pull `default_mac` from `ctx.obj` and accept `--device` to override.

- **`govee_cli/commands/_common.py`** — `resolve()` turns `--device` into a `Target` (device id + model + transport); `parse_segments()` handles `all` / `0,3` / `2-6`; `require_v2()` produces the "this model can't do that" error.

- **`govee_cli/ble/protocol.py`** — The core protocol layer. `encode_*()` functions return `Command` objects; `build_packet(cmd)` produces the final bytes (`[0x33, cmd_type, ...payload, checksum]`). **All GATT UUIDs and packet formats are placeholders pending BLE sniffer verification.**

- **`govee_cli/ble/gatt.py`** — Wraps `bleak.BleakClient`. Connects, writes commands, reads state, subscribes to notifications.

- **`govee_cli/ble/scanner.py`** — Wraps `bleak.BleakScanner` for device discovery, filtered by Govee manufacturer prefix.

- **`govee_cli/devices/h6056.py`** — H6056-specific constants (6 segments, segment layout, scene ID map). `h6022.py` holds the 15-zone layout and that model's four music modes.

- **`govee_cli/schedule/scheduler.py`** — APScheduler-based scheduler; rules persisted in `~/.config/govee-cli/schedule.json`; runs under `govee-cli daemon`.

- **`govee_cli/scenes/`** — Built-in scene JSON files live in `scenes/` at the repo root; `effects.py` parses them; `capture.py` sniffs BLE traffic from the Govee app to build new scene files.

### bleak 3.0 API notes

- `BLEDevice.rssi` and `.metadata` are removed — RSSI/ManufacturerData now live in `device.details['props']`
- `start_notify` callback signature changed to `(char: BleakGATTCharacteristic, data: bytearray) → None`

## The web console (`webui/`)

A FastAPI sidecar (`webui/api/`, loopback :6057) plus a Next.js app
(`webui/app/`, :6056), both systemd **user** units. `./deploy/install-services.sh`
rebuilds and restarts them; nginx is separate and needs sudo.

```bash
cd webui/app && npm run typecheck && npm run lint && npm test && npm run build
python3 scripts/verify_ui.py          # headless browser pass, mock stack, screenshots
```

### The one rule: never claim what the device cannot tell you

`/device/state` returns `""` for `lightScene`, `diyScene`, `musicMode`,
`segmentedColorRgb` and `snapshot` on **every** model, **always** — while still
reporting a stale `colorTemperatureK` from before the scene started. That is a
permanent property of the API. A lamp visibly running a blue/magenta blob morph
reports "2700K", and a console that trusted it drew flat warm white.

`govee_cli/ledger.py` is the fix: a durable local record of what *we* last
commanded, at `~/.config/govee-cli/active-mode.json`, written by every mutating
path in both the CLI and the sidecar. Confidence is computed at read time, never
stored. **When the ledger has no entry the answer is `unknown`** — the UI renders
no scene, no motion and no guess. Preserve that. Adding a plausible fallback
would recreate the exact bug the module exists to prevent.

- Ledger writes happen only after the device command actually succeeded, and a
  ledger failure must never turn a successful light command into an error.
- `mock.py`'s `install()` and `tests/conftest.py` both redirect the ledger path.
  A test that writes to the real file changes what the running console displays.

### Schedules are two things

`schedule.json` is the console's own rules. It is usually empty. The automation
that actually drives the bedroom is a **crontab** line running
`~/.local/bin/wake-ramp` at 06:30 on weekdays, which the console surfaces
read-only via `webui/api/external_schedule.py`.

Reading that crontab from the sidecar is not straightforward: `/usr/bin/crontab`
is setgid, and in a systemd *user* unit any sandboxing directive implicitly
enables `NoNewPrivileges`, which strips the setgid — setting
`NoNewPrivileges=false` does **not** win it back. Hence the fallback chain
`crontab -l` → the spool file → a snapshot written by
`govee-crontab-snapshot.timer`, with the answering route and its staleness
reported to the UI. An unreadable crontab is an error state, never "no
schedules".

**Do not break `wake-ramp`.** It is a live script that wakes Luke up. Back it up
before editing, never run `wake-ramp run` while testing, and diff `wake-ramp
status` against a pre-change capture.

### Geometry

`ModelSpec` carries `matrix_rows`/`matrix_cols`/`matrix_wrap_col` (H6022 = 11x12
wrapped, H6056 = 2x48, H6008 = none). The paint studio draws on that canvas and
downsamples to the 15 segments cloud v2 actually exposes, showing both — the lamp
cannot render what you drew, and the UI says so rather than implying otherwise.

### The 3D stage

Every device renders as a real model in `webui/app/src/lib/lamp3d/`, not a
silhouette with a gradient over it. **One** `WebGLRenderer` for the whole app,
mounted as a single fixed canvas and scissored per stage box, driven by
`motion-engine/driver.ts` — still the only `requestAnimationFrame` in the app.
`led-field.ts` is the seam: `(MotionSpec, layout, t) -> RGB per LED`, pure and
GL-free, so every archetype is testable in Node.

Things that cost a round to learn, all of which look correct in code:

- **three multiplies viewport/scissor by the pixel ratio itself**, so pass it CSS
  pixels. Device pixels double-apply. At dpr 1 that is invisible; on a phone the
  lamp draws off-screen and the stage is an empty box while a "does the canvas
  animate" check still passes, because the canvas is animating somewhere else.
  **Check a phone, not just a desktop.**
- **An sRGB texture must be RGBA.** WebGL2 has no three-channel sRGB format.
  `RGBFormat` + `SRGBColorSpace` is rejected on every upload and the lamp renders
  unlit.
- **Do not light the lamp with its own spill.** A spill centroid averages a
  drum's twelve columns onto the cylinder axis, i.e. inside the shade. The spill
  lights live on `SPILL_LIGHT_LAYER` and reach the ground only.
- **Emission cannot compete with a blown-out surface.** The body has to sit dark
  before the LEDs turn on, and tone mapping has to be on, or every bright LED
  clips to the same white.
- **`GET /devices` sends no `capabilities`**, so a plate cannot learn its matrix
  from the wire; `MODEL_MATRIX` in `models/types.ts` mirrors `transport.py`.
  Capabilities still win when present.
- The canvas sits **above** the app frame (z-10, below dialogs at z-50): the
  frame's background is opaque, so behind it nothing is visible. Views clip to
  their scrolling ancestor or they paint over the TopBar.
- **The clip box and the camera box are two different rects.** `readBoxes()`
  intersects a view with its scrolling ancestor; feeding that one rect to both
  `setViewport` and `setScissor` collapses a distinction `computeFrameRects`'s
  own comment insists on, and the lamp visibly squashes as it scrolls under the
  TopBar. Viewport and aspect come from the **full element box**; only the
  scissor is clipped.
- **`pointer-events-none` on the mount div means orbit controls never fire.**
  `attachOrbitControls` attaches to that element, so the listeners were never
  invoked on any device — and `cn()` will not reliably let a later
  `pointer-events-auto` win. Only the hero opts in; plates stay inert inside
  their `<Link>`.
- **Claim a drag differently for mouse and touch.** Requiring horizontal
  dominance is right for touch, where page scroll competes for the finger, and
  wrong for a mouse, where it silently ate every vertical drag.
- **Colour and brightness are separate device fields, so don't multiply them.**
  Feeding `colorRgb` straight to emissive radiance double-counts darkness: a
  lamp set to `#330066` at 100% is a *bright purple*, and the render showed a
  grey ball. `frameNormalizeGain` lifts the frame's peak to full — hue and
  saturation untouched, brightness still carried by `emissiveIntensity` alone.
  Normalize per **frame**, never per LED, or a chase's dim tail is dragged up
  to meet its bright head and the pattern dies.
- **A wash and a blackout are the same bug from opposite sides.** Emission gain,
  `SHADE_SCATTER` and a white `sheen` all compound; on a cylinder most visible
  surface is grazing, so sheen paints white nearly everywhere. Retune them
  together, and check a saturated scene rather than a solid colour.
- **The camera fits a bounding BOX, not a sphere.** A sphere is driven by the
  largest dimension in any direction, so the H6056's wide-and-short pair was
  framed as if it were as tall as it is wide and sat small in an empty stage.
- **A lit panel can be buried inside its own shell.** `ExtrudeGeometry`'s
  `bevelSize` extends the contour *outward* from the outline, so the solid is
  thicker than the cross-section it was authored from: the H6056's face sat at
  `BAR_DEPTH / 2 + epsilon` and rendered as a dark slab with a correct glowing
  halo behind it. Emission that is computed, uploaded and invisible looks
  exactly like emission that is broken. Position parts from **measured**
  geometry, and assert the face is proud of its shell in the shared parent's
  space (world-space `max.z` is not "in front of" once anything is pitched).
- **Lathe profiles need spline sampling.** A lathe interpolates linearly
  between profile points, so eleven hand-placed points around a bulb dome are
  eleven visible creases.
- **`fcntl` is POSIX-only and it made the whole package unimportable on
  Windows** — including the mock sidecar `verify_ui.py` boots, so the visual
  pass could not run at all. `govee_cli/filelock.py` is the one place that
  difference lives. Its process-local `threading.RLock` is load-bearing, not
  decoration: Windows returns `EDEADLOCK` for same-process contention on a byte
  range, and the never-raise contract then *silently dropped ledger writes*.
- Verifying any of this means **setting a real mode first**. A device at
  `power: false` or ledger `unknown` renders correctly dark, which is
  indistinguishable from a broken emission path in a screenshot. Print the
  device's reported state next to the render.

`scripts/verify_ui.py` asserts motion by screenshotting the canvas element.
It cannot use `toDataURL` — a WebGL drawing buffer is cleared after compositing
and returns blank, so the check would fail on working code.

### The request meter, and what it may not claim

`govee_cli/request_meter.py` counts every outbound cloud request, hooked **inside
`GoveeHTTPv2._request`** rather than at any call site — three independent clients
exist in this process tree (the sidecar's singleton, a fresh one per scheduler
firing, one per CLI invocation) and `_request` is the only point all three share.
Every retry attempt counts; each is a real request.

**We do not know v2's rate limit.** It publishes none and returns no headers, so
the meter shows measured counts and never a percentage of an invented
denominator — that would be the same sin as reporting 2700K for a lamp running a
blue scene. The only thing allowed to raise a warning is `rate_limited_today > 0`:
a 429 is the cloud actually saying so. A daily target is opt-in
(`request_budget_per_day`, default `None`) and is presented as the user's number.
v1 and v2 are metered separately and are never summed.

Measured 2026-08-25: a focused dashboard draws **26 req/min** (~37,400/day if
left open), with **zero 429s**. `POLL_MS` and `STATE_CACHE_TTL` are deliberately
untuned pending that evidence.

Its flush deliberately **omits `fsync`**, unlike `ledger.py`. `os.replace` still
gives atomicity; `fsync` only adds durability across a power cut, at a measured
p50 of 124ms on this disk — inside `playback.py`'s 500ms frame budget. Losing the
ledger's last write means lying about a light; losing the meter's means a tally
is two seconds stale.

### Room scenes are a third thing

`groups` broadcast one command string. Govee's `snapshot` is per-device and
firmware-side. A **room scene** (`govee_cli/room_scenes.py`,
`~/.config/govee-cli/room-scenes.json`) captures every device's state *and*
ledger mode, and restores them to four different modes at once.

`plan_restore()` is pure so its mode dispatch is testable without hardware. A
device captured while its mode was `unknown` — or running an `effect` — is
**skipped with a stated reason, never guessed**. That is the ledger's own rule
one level up, and it is why `PUT /devices/{ref}/active-mode` exists: correcting
an `unknown` is what makes a capture worth taking. That route writes the ledger
and **sends nothing to the device**; the UI copy has to keep saying so, because a
user who thinks it commands the light will mis-set the ledger.

**`resolve_ref` falls back to treating any MAC-shaped string as an ad-hoc BLE
address, and mock mode does not cover BLE** — it fakes only the HTTP client. Any
code path that resolves a stored device id must check `target.device_cfg is not
None` first, or a stale reference becomes real GATT packets to whatever answers.
This has already happened once, to real hardware in a bedroom.

### Mobile changes are gated, not eyeballed

`scripts/viewport_audit.py` is the instrument for "this must not change desktop".
`--baseline` records every visible element's box at 1440x900 into
`.planning/desktop-baseline.json` (committed — it captures a state no later run
can reproduce); `--check` diffs it and then sweeps 390x844 in both themes for
clipped content, sub-44px touch targets, off-viewport controls and scroll rows
with no affordance. It reuses `verify_ui.py`'s stack by import, mock guard
included.

Only two mechanisms may be used to change mobile without moving desktop:
`max-md:`/`max-sm:` variants, and `@media (pointer: coarse)` (Tailwind's
`pointer-coarse:`). A bare class change, or a changed `sm:`/`md:`/`lg:` value,
applies at desktop and the gate will say so.

Three things the gate cannot see, all learned by running it:

- **It measures boxes, not paint.** Growing a control to 44px by putting the
  height on the element that carries the border and background makes a 44px slab
  of chrome; both versions measure 44px. **Grow the hit area, not the ink** —
  put the visual on an inner span.
- **Screenshots only show the first viewport.** The app frame is `h-dvh` with an
  inner `overflow-y-auto`, so the document is exactly one viewport tall and
  Playwright's `full_page=True` has nothing extra to capture.
- **Anything positioned from the current time needs `data-volatile="true"`**, or
  it reports as a regression an hour after the baseline. The clock, the latency
  readout, the timeline's "now" marker and the next-fire countdowns all carry it.

**The desktop baseline is platform-specific and only means anything on Linux.**
`.planning/desktop-baseline.json` records DOM geometry in pixels, and text box
widths come from the OS font stack. Running `--check` against it from a Windows
workstation reports hundreds of diffs on every route — including ones the change
never touched — concentrated in `flex-1` spacers absorbing different text widths.
That is the measurement disagreeing with itself, not desktop moving. Do not
re-baseline to make it green: the file captures a pre-change state no later run
can reproduce. Run this gate on the machine the baseline came from, and say so
plainly when you cannot.

`title="..."` is a hover tooltip and touch has no hover, so a `truncate` + `title`
pair is a desktop-only reveal. Under `pointer: coarse` such a string must wrap.

`cn()` is a plain string join with no `tailwind-merge`: a `hidden` passed to a
component whose base class sets `inline-flex` does **not** reliably win — the
emitted rule order decides. Put visibility on a wrapper. This cost a round: the
`poll 10s` chip was believed hidden on phones for months and never was.

### Anything that writes to `~/.config/govee-cli/` needs a test redirect

`tests/conftest.py` redirects the ledger, the meter and room scenes; `mock.py`'s
`install()` does the same for the sidecar. Add a new state file and you must add
it to both, or the test suite silently rewrites what the running console
displays. This has now bitten twice — first the ledger, then the meter, where
test runs wrote fabricated 429s into the one signal the budget readout treats as
ground truth.

---

## Device Notes (H6056)

- **Static MAC**: `D0:C9:07:FE:B6:F0` (use for config)
- **Advertised name/address**: `Govee_H6056_440C` / `DD:6E:86:46:44:0C` (random, may change)
- **GATT write characteristic**: `00010203-0405-0607-0809-0a0b0c0d2b11` (all commands go here)
- **GATT notify characteristic**: `00010203-0405-0607-0809-0a0b0c0d2b10` (responses arrive here)
- Device must be found by `govee-cli scan` first; connect by name or random address

## Device Notes (H6056 — Light Bars, dual transport)

- **Cloud device ID**: `6D:19:DD:6E:86:46:44:0C` — **BLE address is the last 6
  octets, `DD:6E:86:46:44:0C`** (confirmed by scan: "DD:6E:86:46:44:0C
  Govee_H6056_440C"). Handing the 8-octet cloud id to bleak can never connect;
  `Target.ble_mac` does the derivation. Same rule holds for the H6022
  (`50:CE:...:50:3F` → `E8:6E:80:C6:50:3F`), but **not** for the GVH H6008,
  which advertises the last six octets *+1 on the final byte* — see below.
- **Cloud v2 unlocks**: 69 firmware scenes (BLE table has 27, some unreversed),
  4 DIY scenes, segments 0-14, **segmentedBrightness** (the H6022 lacks this),
  8 music modes, `gradientToggle`.
- **Segment count differs by transport**: 15 over cloud, 6 over BLE. The API
  accepting an index is not proof the hardware has that zone.
- **`dreamViewToggle` is advertised and then rejected** by the hardware:
  400 "The device does not has DreamView". The advertised capability list is a
  probing hint, never a guarantee.
- **Music modes**: Vivid 0, Strike 1, Rhythm 2, Vibrate 3, Beat 4, Torch 5,
  RainbowCircle 6, Shiny 7. These integers are **not** the H6022's — 4 is `beat`
  here and `rolling` there, so a mix-up silently sets the wrong mode.
- See `docs/H6056_PROTOCOL.md`.

## Device Notes (H6008 — GVH-series: BLE blocked, cloud working)

- **BLE MACs**: `5C:E7:53:69:87:FB` (Lamp Front), `5C:E7:53:63:8F:01` (Lamp Top).
  Note these are the cloud ids' last six octets **+1** (`...87:FA` → `...87:FB`,
  `...8F:00` → `...8F:01`) — the H6056/H6022 last-6 rule does not hold here.
  Moot in practice: this revision's BLE command protocol does not work.
- **Advertised names**: `GVH600887FB`, `GVH60088F01`
- **OUI**: `5C:E7:53` (HOMY IOT SOLUTIONS) — different chip from ihoment_ H6008
- **Cloud v2 works fully** (migrated off v1 2026-08-14): power, brightness, color,
  temp, **56 firmware scenes** and DIY scenes. Scenes are entirely new — the bulb
  had none over any transport before. It genuinely lacks segments, segment
  brightness, music and toggles (all 400 "devices not support this instance").
- **Status (BLE only)**: protocol unknown. Connects fine, GATT writes accepted,
  bulb ignores all commands. The "BLOCKED" label below is about BLE, not the device.
- **0x33 protocol does not work** on this hardware revision.
- **No WiFi available** (eduroam only, WPA2-Enterprise incompatible with IoT devices).
- **Cloud/LAN API not viable** without a WPA2-Personal network for the bulbs.
- **Unblocking requires**: nRF52840 passive BLE sniffer dongle (~$10) OR successful iOS sysdiag capture to see what the Govee app sends.
- See `docs/H6008_PROTOCOL.md` for full investigation.

## Device Notes (H6022 — RGBIC Table Lamp 2, FULLY WORKING)

- **Cloud device ID**: `50:CE:E8:6E:80:C6:50:3F` (registered as `Shelf Lamp`, group `shelf`)
- **Transport**: cloud v2 **only**. Invisible to the v1 API — a v1 code path cannot see it.
- **Working**: power, brightness, color, temp (2700–6500K), 15-segment color, 94 firmware
  scenes, DIY scenes, firmware music mode, cloud-driven keyframe effects.
- **Segments**: 0–14 addressable; index 15 → 400 `Parameter value out of range`.
  Two-tone painting confirmed on the physical lamp. **These 15 are an API
  template, not the lamp's geometry** — the firmware interpolates them onto
  the matrix by an undocumented rule.
- **It is a matrix, not a strip**: 132 leds as 12 columns wrapped around the
  drum × 11 rows (`index = row*12 + col`, col 0 touches col 11). Confirmed by
  dvdavd/govee-lan-ha, dvdavd/govee-h6022-ble and OpenRGB. The Govee app's
  draw grid is this canvas. Cloud v2 cannot send matrix frames — full-res
  drawing needs LAN (blocked, see below) or the encrypted BLE protocol.
- **`segmentedBrightness` is not supported** → 400 `devices not support this instance`.
  (Useful signal: the API really does distinguish supported instances, so a 200 elsewhere means something.)
- **BLE**: a published encrypted protocol exists (dvdavd/govee-h6022-ble) —
  20-byte XOR frames like the classic models but AES-128-ECB + RC4 under a
  session key from a `0xe7` handshake. The repo's placeholder 0x33 protocol
  cannot talk to it. Implementing it means porting the crypto + handshake.
- **Do NOT enable LAN Control** for this lamp — an open upstream bug
  (wez/govee2mqtt#518) reports it makes the H6022 unresponsive even to its own
  buttons until LAN Control is turned back off.
- See `docs/H6022_PROTOCOL.md` for payload shapes and the full investigation.

### H6022 gotchas

- `diyScene` takes a **bare int**; `{"value": n}` is rejected with `Missing relevant parameters: id`.
- `lightScene` needs **both** `paramId` and `id`.
- `/device/state` returns `""` for scene/segment/music **always** — an empty value is not
  evidence of failure. Those can only be confirmed visually.
- Setting `colorTemperatureK` zeroes `colorRgb` and vice versa; they are mutually exclusive.
- Music mode integers are **model-specific**. H6022 = Rhythm 3, Rolling 4, Energic 5,
  Spectrum 6. The H6056 uses an entirely different mapping. Never share these across models.

## Protocol Status

**This section describes the BLE protocol only.** Everything below is about the
0x33 GATT path. Scenes, segments, music, DIY and toggles are all reached over
cloud v2 now for every model that has hardware here, so an "unverified" BLE item
is no longer a blocker for that feature — it just means the BLE encoding for it
was never confirmed. See the per-device sections above for what actually works.

**Confirmed working (community sources + GATT dump):**
- BLE scanning
- GATT service/characteristic UUIDs
- Packet format: `[0x33][cmd][payload padded to 18 bytes][XOR checksum]` = 20 bytes
- `power on/off` — command byte `0x01`
- `brightness` — command byte `0x04`
- `color` — command byte `0x05`, mode byte `0x02` (MODE_2, all segments)

**Unverified (best-guess, needs btmon capture):**
- `temp` — mode byte `0x05` assumed, Kelvin encoding unconfirmed
- `segments` — MODE_1501 format assumed from H6053 sibling; bitmask TBD
- `scene` — mode byte `0x04`, but scene IDs for H6056 unknown
- `parse_state` — notification response format unknown
- `music`, `effect` — command bytes unconfirmed

**To capture remaining protocol:** run `btmon` while using the official Govee app, then `govee-cli record` to save packets. Update `govee_cli/ble/protocol.py` with real values.

## Testing Sequence

`govee-cli info --device <name>` first — it prints the transport, segment counts
per transport, colour-temp range, cloud features and toggles for that model, and
is read-only. Then start simple and verify each step:

```bash
source .venv/bin/activate
govee-cli scan-http                          # register devices from the cloud
govee-cli info --device "Light Bars"         # read-only: transport + capabilities
govee-cli state --device "Light Bars"        # read-only: current state

govee-cli power on --device "Light Bars"
govee-cli brightness 50 --device "Light Bars"
govee-cli color FF0000 --device "Light Bars"
govee-cli temp 4000 --device "Light Bars"

# Cloud-only features (nothing to verify over BLE):
govee-cli scene list --device "Light Bars"   # 69 scenes
govee-cli segments 0-2 FF0000 --device "Light Bars"
govee-cli segments 0-2 --brightness 30 --device "Light Bars"
govee-cli music list --device "Light Bars"
govee-cli toggle --device "Light Bars"
```

Basic control reads back through `state`; scenes, segments and music do not —
the device reports `""` for those on every model, so a 200 is the only signal
the API gives you.

---

## Development Workflow

### Subagent-Driven Development

This project uses **subagent-driven-development** for all non-trivial changes:

1. **Task dispatch** — Each feature/fix gets its own subagent
2. **Spec compliance review** — Code reviewer verifies implementation matches requirements
3. **Code quality review** — Second review checks for issues (confidence >= 80)
4. **User validation** — User tests before moving to next task

**Critical workflow rule:** Never skip reviews. Both spec compliance AND code quality reviews are mandatory.

### Communication Protocol

**User is the authority.** When user says:
- "Use X as source of truth" → Use X, don't argue
- "Follow the systematic debugging skill" → Follow it exactly
- "Stop guessing" → Stop, investigate root cause

**Anti-patterns to avoid:**
- Ignoring user instructions to "do it my way"
- Deflecting questions instead of answering directly  
- Patronizing explanations (user knows what they're doing)
- Jumping between approaches without finishing any

### Research Methodology

**Parallel Implementation Research** for protocol reverse engineering:

1. **Check existing repos FIRST** — Look at sisiphamus/govee-controller, egold555/Govee-Reverse-Engineering, wez/govee-py
2. **Community consensus** — Check Home Assistant issues, GitHub issues
3. **Only then capture** — If existing docs insufficient, use btmon/hcidump

**The H6008 lesson:** The working implementation was already documented in sisiphamus/govee-controller. Should have looked there immediately instead of trying to capture fresh traffic.

### Debugging Discipline

**Systematic Debugging skill applies ALWAYS:**
1. Phase 1: Root cause investigation (no fixes yet)
2. Phase 2: Pattern analysis (compare working vs broken)
3. Phase 3: Single hypothesis, test minimally
4. Phase 4: Implement one fix, verify

**Red flags:**
- "Quick fix for now, investigate later"
- Multiple fixes at once
- Already tried 2+ fixes without success
- Answering "probably X" without verification

### When Tools Fail

**btmon/hcidump on Pop!_OS:**
- `btmon` 5.72 crashes immediately on startup with SIGABRT (glibc stack protector, buffer overflow in btmon itself — not a traffic volume issue). Building from source (5.75) did not fix it.
- `hcidump` works but only captures the Linux machine's own HCI traffic (`hci0`). Cannot see iPhone BLE traffic.
- **Single-connection BLE limit**: cannot passively monitor a bulb while another device (phone) is connected to it. Passive sniffing requires dedicated hardware (nRF52840 dongle).

**The GVH H6008 lesson:** The `ihoment_H6008` (OUI `98:17:3C`) protocol is documented in sisiphamus/govee-controller and works. The **GVH H6008** (OUI `5C:E7:53`, company ID `0x8843`) is a completely different hardware revision with an undocumented BLE protocol. The `0x33` protocol does not work on GVH-series devices. No community reverse engineering exists for this variant. See `docs/H6008_PROTOCOL.md` for full investigation notes.
