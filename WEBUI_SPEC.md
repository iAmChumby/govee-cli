# WEBUI_SPEC.md — govee-cli Web Console

Single source of truth for the web UI built on top of govee-cli. Every agent
implements against this document. Where this document and code disagree, this
document wins until amended.

---

## 1. Mission

A self-hosted web console exposing **everything `govee-cli` can do**, for
browsers on the owner's tailnet. Humans/agents keep using the CLI; the owner
uses the GUI. Both hit the same Python library (`govee_cli`), so parity is
structural, not aspirational.

Non-goals: multi-user auth (tailnet is the boundary), mobile app, cloud relay.

## 2. Architecture

```
browser ── https://pop-os:6056 ── nginx ── localhost:6056  Next.js (webui/app)
                                              │ rewrites /api/v1/*
                                              ▼
                                    localhost:6057  FastAPI sidecar (webui/api)
                                              │ imports
                                              ▼
                                         govee_cli (library)
```

- **Next.js 15 App Router + TypeScript + Tailwind v4** — all UI.
- **FastAPI sidecar** — thin REST layer over `govee_cli` internals. No CLI
  subprocess parsing. Runs on `127.0.0.1:6057`, never exposed.
- **Ports**: public `6056` (the H6056's number — deliberate), internal `6057`.
- **Mock mode**: env `GOVEE_WEBUI_MOCK=1` makes the sidecar serve deterministic
  fixtures with in-memory state and never touch real devices or the real
  `~/.config/govee-cli` files (config/schedule paths are redirected to a temp
  dir). This is how development, demos and visual tests run off-hardware.
- **Scheduler embedding**: env `GOVEE_WEBUI_SCHEDULER=1` (default on) starts the
  schedule engine inside the sidecar process, reusing
  `govee_cli.commands.daemon.SchedulerDaemon` logic. Docs must note: run either
  the webui stack or `govee-cli daemon` as a service, not both.

### Repo layout

```
webui/
  api/                 FastAPI sidecar (Python 3.10+, ruff+mypy clean)
    main.py            app factory, startup hooks (scheduler), CORS off
    deps.py            config/client providers, mock switch
    mock.py            fixture devices + MockV2 client + path redirection
    routers/
      devices.py       discovery, info, state, power/brightness/color/temp
      scenes.py        scenes, diy, snapshots, music, toggles, segments
      groups.py
      schedules.py
      config.py
      effects.py       keyframe effect playback manager (start/stop/status)
    schemas.py         pydantic request/response models
  app/                 Next.js
    src/app/…          routes
    src/components/…   ui primitives + feature components
    src/lib/…          api client, query hooks, design tokens
deploy/
  govee-webui.service        Next.js unit (port 6056)
  govee-webui-api.service    FastAPI unit (port 6057)
  nginx-govee.conf           site block example
WEBUI_SPEC.md               this file
```

## 3. Domain facts agents must respect

From `govee_cli/transport.py` (read it; do not hardcode around it):

| Model | Transport | Segments (cloud/BLE) | Temp K | Scenes | DIY | Seg brightness | Music | Toggles |
|---|---|---|---|---|---|---|---|---|
| H6056 | cloud-v2 | 15 / 6 | 2000–9000 | ✓ | ✓ | ✓ | ✓ (8 modes) | gradientToggle |
| H6008 | cloud-v2 | – / – | 2700–6500 | ✓ | ✓ | ✗ | ✗ | – |
| H6183 | cloud-v1 | – / – | default | ✗ | ✗ | ✗ | ✗ | – |
| H6022 | cloud-v2 | 15 / – | 2700–6500 | ✓ | ✓ | ✗ | ✓ (4 modes) | – |

- Unregistered models fall back to BLE basic control only.
- Music mode integers are per-model; always fetch via the model handler.
- v2 state returns `""` for scene/segment/music instances — absence of value is
  not failure. Only power/brightness/colorRgb/colorTemperatureK/online are
  reliable reads.
- The cloud rate-limits hard (~2 req/s sustained, daily budget). The API layer
  adds a short TTL cache (≥2 s) on state reads to absorb UI polling bursts;
  the UI polls slowly (10 s) and shows a manual refresh affordance.
- Setting colorTemperatureK zeroes colorRgb and vice versa (H6022 verified).
- `dreamViewToggle` is advertised but rejected by hardware — surface device
  errors verbatim rather than hiding them.

## 4. API contract (`/api/v1`)

Conventions:
- All responses JSON. Errors: `{ "error": { "code": str, "message": str } }`
  with status 400 (bad input), 404 (unknown ref), 409 (device rejected /
  unsupported feature), 502 (cloud unreachable/rate-limited). Message text
  should carry the CLI's own wording where one exists.
- Device refs: name or id, resolved exactly like `_common.resolve()` →
  `resolve_target()`.
- State is normalised everywhere:

```json
{
  "ref": "Shelf Lamp", "id": "50:CE:E8:6E:80:C6:50:3F", "model": "H6022",
  "name": "Shelf Lamp", "transport": "cloud-v2", "online": true,
  "power": true, "brightness": 42,
  "color": {"hex": "#FF8800", "rgb": [255,136,0]},
  "color_temp_k": null,
  "capabilities": {
    "segments": true, "segment_brightness": false, "scenes": true,
    "diy": true, "music": true, "toggles": ["gradientToggle"],
    "temp_min": 2700, "temp_max": 6500,
    "segment_count_cloud": 15, "segment_count_ble": 0,
    "prefer_ble_effects": false
  }
}
```

### Endpoints

```
GET    /health                     → {status:"ok", version, mock:bool, scheduler:bool}
GET    /devices                    → DeviceSummary[] (config registry + last known state)
POST   /devices/discover           → v2 scan; body {sync?:bool=true}; returns found devices w/ capabilities
GET    /devices/{ref}              → Device (full, incl. capabilities + state)
GET    /devices/{ref}/state        → DeviceState (normalised)
PUT    /devices/{ref}/power        → {on:bool}
PUT    /devices/{ref}/brightness   → {value:int 1..100}
PUT    /devices/{ref}/color        → {hex:"RRGGBB"|#RRGGBB}
PUT    /devices/{ref}/temperature  → {kelvin:int} (validated against spec bounds)
POST   /devices/{ref}/segments     → {segments:"all"|"0,3"|"2-6"|int[], hex?:str, brightness?:int 0..100}
GET    /devices/{ref}/scenes       → {scenes:[{name,param_id,scene_id}], cached:bool}
PUT    /devices/{ref}/scenes       → {name:str}; ?refresh=1 bypasses cache
GET    /devices/{ref}/diy          → {scenes:[{name,value}]}
PUT    /devices/{ref}/diy          → {name:str}
GET    /devices/{ref}/snapshots    → {snapshots:[{name,value}]}
PUT    /devices/{ref}/snapshots    → {name_or_id:str}
GET    /devices/{ref}/music        → {modes:[{key,value}], supported:bool}
PUT    /devices/{ref}/music        → {mode:str, sensitivity:int=60, auto_color?:bool, hex?:str}
GET    /devices/{ref}/toggles      → {toggles:[{instance,verified:bool}]}
PUT    /devices/{ref}/toggles      → {instance:str, on:bool}
GET    /groups                     → {groups:{name:[refs]}}
POST   /groups                     → {name, devices:[refs]}
DELETE /groups/{name}
GET    /groups/{name}/state        → per-member normalised states + errors[]
POST   /groups/{name}/run          → {command:str} same verbs as `group run`; per-device results
GET    /schedules                  → ScheduleRule[]
POST   /schedules                  → {name,time HH:MM,days[Mon..],command,device?}
PATCH  /schedules/{id}             → {enabled:bool}
DELETE /schedules/{id}
GET    /config                     → redacted config (api_key → "•••"+last4, or null)
PATCH  /config                     → any of default_mac/default_timeout/default_brightness/default_color
POST   /config/devices             → {mac,model,name?,static_mac?} register/edit
DELETE /config/devices/{mac}
GET    /effects                    → effect files found in repo scenes/*.json (parsed metadata)
POST   /effects/play               → {device:ref, file:name, fps?, force?: "ble"|"cloud"} starts background task
DELETE /effects/playing/{ref}      → stop that device's playback
GET    /effects/playing            → [{device,file,fps,transport,started_at}]
```

Sidecar requirements:
- Sync wrappers around blocking calls via `anyio.to_thread` (requests lib is
  blocking); never block the event loop.
- Effect playback runs as managed asyncio tasks (BLE path uses the existing
  async engine; cloud path runs in a worker thread). One playback per device;
  starting a new one stops the old.
- Mock mode implements every endpoint with realistic fixtures: three devices
  ("Light Bars" H6056, "Shelf Lamp" H6022, "Bulb" H6008), ~12 scenes for the
  bulb, 69-ish names for bars/lamp, 4 DIY, music modes per model, groups
  ("living-room"), two schedule rules. Mutations update in-memory state so the
  UI visibly reacts. Add small artificial latency (150–400 ms) to exercise
  loading states.
- Tests: pytest with fastapi TestClient against mock mode; cover every route's
  happy path + one error path each. Existing test suite must stay green.

## 5. Frontend

### 5.1 Identity

App name: **filament** — lowercase wordmark, tagline "govee control console".
It should feel like a precision lighting desk designed by one person who owns
the same lights you do.

### 5.2 Design language — "control room"

Handcrafted instrument-panel aesthetic. Warm, mechanical, precise. Explicitly
banned: purple/blue gradients, glassmorphism blur cards, neon glow chrome,
generic SaaS dashboard look, Inter/Roboto as identity font, emoji icons,
terminal-green-on-black pastiche, drop shadows floating in space.

**Typography** (next/font/google):
- Display: `Instrument Serif` — headings, scene names, big numerals get mono
  instead. Italic reserved for flourish words ("mood", "scene").
- UI: `Archivo` — body and labels. Micro-labels: uppercase, tracking 0.14em,
  11px, color-mid.
- Data: `IBM Plex Mono` — values, IDs, times, temperatures. Tabular.

**Color tokens** (CSS custom properties, both themes):

| token | dark | light |
|---|---|---|
| --bg | #131110 | #EDE7D9 |
| --panel | #1B1815 | #F6F1E4 |
| --raised | #242019 | #FCF8ED |
| --hairline | ivory @ 9% | ink @ 13% |
| --hairline-strong | ivory @ 18% | ink @ 26% |
| --text-hi | #EFE7D6 | #211C15 |
| --text-mid | #A89F8D | #5C5546 |
| --text-low | #6E675B | #8A8272 |
| --accent | #E3A455 | #96601A |
| --accent-press | #C98B3F | #7C4E12 |
| --ember | #C4553B | #A93F27 |
| --sage | #8FA982 | #55703F |

Device light colors are *content* rendered inside previews/swatches — never
used as UI chrome accents.

**Borders & corners** — one system, no exceptions:
- Hairline 1px borders at --hairline; interactive hover raises to
  --hairline-strong.
- Radius scale: 3px inputs/chips · 6px buttons · 10px panels · 16px overlays.
- Signature: major panels carry an **offset outer ring** (1px hairline 4px
  outside the border = engraved faceplate) plus **corner ticks** — 8px L-shaped
  registration marks at the four corners, drawn with pseudo-elements/SVG.
  Buttons and chips never get ticks.

**Motion** — nothing snaps, ever:
- framer-motion (`motion/react`) springs everywhere.
  Standard spring: stiffness 260 damping 26. Heavy panels: 170/22.
- CSS `@property`-registered custom props (--glow-alpha, --glow-scale) so
  gradients/filters interpolate continuously.
- Power toggle = filament warm-up: preview glow ramps through warm→set color
  with spring; never a class flip.
- Numeric readouts roll odometer-style (per-digit spring columns).
- Theme switch: View Transitions API radial reveal from the toggle position;
  fallback soft 250ms crossfade. Never a hard flip.
- Scene apply: light ripple sweeps across the stage preview.
- Respect prefers-reduced-motion: springs → opacity fades ≤180ms.
- Loading: skeleton shimmer kept subtle (low-alpha pulse), spinners banned
  except tiny inline ones; prefer progress via layout (panels breathe open).

### 5.3 Information architecture

- `/` **Console** — grid of device plates (mini live preview, power, brightness
  scrub, current color/temp readout), groups strip with group actions, global
  scene search across devices.
- `/device/[ref]` **Device console** — left: Stage (large faithful renderer);
  right: control deck tabs — Light · Segments · Scenes · DIY · Snapshots ·
  Music · Toggles · Effects (tabs render only if capability exists).
- `/schedules` — rule list with enable toggles, add-rule sheet, next-fire time.
- `/settings` — defaults, device registry editor, groups editor, connection
  health (mock indicator, scheduler status).
- Global: top bar (wordmark, breadcrumb, theme switch, refresh cadence),
  bottom status strip (API latency, mock badge, clock, rate-limit hint),
  ⌘K command palette (devices, scenes, power actions).

### 5.4 Stage renderer (centerpiece)

Per-model faithful rendering with continuous interpolation:
- **H6056**: two vertical tri-zone bars on machined bases; segments map 0-2
  left top→bottom, 3-5 right.
- **H6022**: table lamp silhouette, 15 vertical zones.
- **H6008**: single orb bulb with halo.
- Renders power/brightness/color/temperature from live state; glow via layered
  radial gradients + blur, driven by registered custom props. Clickable
  segments enter paint mode (select targets → apply color/brightness).
- Unknown models: generic bar of N zones or single orb.

### 5.5 Stack rules

- npm (no pnpm/yarn). Node 22.
- TanStack Query v5: keys like `['device', ref, 'state']`; state poll 10 s,
  `refetchOnWindowFocus` on; mutations optimistic where safe (power,
  brightness, color) with rollback on error toast.
- next-themes (class strategy), default dark, respects system.
- No component library beyond Radix primitives where needed (dialog, popover,
  slider, tabs) — styled to the token system.
- TypeScript strict. ESLint + `next build` must pass clean.

## 6. Verification gates (every phase)

- Sidecar: `ruff check webui/api`, `mypy webui/api`, `pytest` green.
- Frontend: `npm run build`, `npm run lint`, `tsc --noEmit` green.
- Visual: Playwright screenshots at 1440×900 and 390×844, both themes, against
  mock mode. Check contrast AA on text tokens.
- Commits: conventional (`feat(webui): …`, `fix(webui): …`, `chore(webui): …`),
  small and sequential; never break `pytest` on main.
