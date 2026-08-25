# filament — govee-cli web console

A self-hosted web console exposing everything `govee-cli` can do. Humans and
agents keep using the CLI; you get the GUI. Both drive the same Python
library, so parity is structural.

```
browser ── https://pop-os:6056 ── nginx ── 127.0.0.1:6056  Next.js (webui/app)
                                             │ rewrites /api/v1/*
                                             ▼
                                   127.0.0.1:6057  FastAPI sidecar (webui/api)
                                             │ imports
                                             ▼
                                        govee_cli library
```

- **Auth**: none, by design — your tailnet is the boundary.
- **Ports**: public `6056` (the H6056's number), sidecar `6057` loopback-only.
- **Design language**: "optical" — monochrome graphite chrome; every drop of
  color on screen is light content. Dark and light themes; nothing snaps.

## What it can do

Everything the CLI can: power, brightness, color, temperature, per-segment
paint (with a live stage renderer per model), firmware scenes, DIY scenes,
snapshots, music modes, toggles, keyframe effect playback with start/stop,
groups with broadcast commands, schedule rules, device discovery/registry and
config defaults — plus live state polling that respects the cloud's rate
budget.

## Run it (homelab)

### 1. Sidecar

```bash
cd ~/projects/govee-cli
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[webui]"
python -m webui.api.main          # serves 127.0.0.1:6057
```

The sidecar embeds the schedule engine (`GOVEE_WEBUI_SCHEDULER=1`, default on).
Run **either** this unit **or** `govee-cli daemon` as a service — not both.

### 2. Frontend

```bash
cd webui/app
npm ci
npm run build
npm run start -- -p 6056 -H 127.0.0.1
```

### 3. Services + nginx

`deploy/` ships two scripts. The app services are systemd **user** units, so
only nginx needs root:

```bash
./deploy/install-services.sh        # no sudo: deps, build, user units, restart
./deploy/install-nginx-govee.sh     # sudo: nginx site + reload, batched
```

Re-run `install-services.sh` after any pull that touches `webui/`; the nginx
one only when `deploy/nginx-govee.conf` changes. Both are idempotent and
verify themselves.

Then browse `https://100.121.176.1:6056` (or `https://pop-os:6056` on the
tailnet). The cert is the shared self-signed `tailscale-proxy` cert, so expect
the usual browser warning.

nginx binds the Tailscale IP (`100.121.176.1:6056`) while Next.js binds
`127.0.0.1:6056` — different addresses, no clash, and the console never
reaches the LAN.

## Demo mode (no hardware, no config writes)

```bash
GOVEE_WEBUI_MOCK=1 python -m webui.api.main   # terminal 1
cd webui/app && npm run dev                    # terminal 2
```

Mock mode serves three fixture devices ("Light Bars", "Shelf Lamp", "Bulb")
with in-memory state and redirects all library file writes to a temp dir, so
it can never touch real devices or `~/.config/govee-cli`.

## Development

```bash
# sidecar checks
ruff check webui/api && mypy webui/api && pytest tests/test_webui_api.py

# frontend checks (inside webui/app)
npx tsc --noEmit && npm run lint && npm run build
```

Layout and contracts live in `WEBUI_SPEC.md` at the repo root — API shapes in
§4, design tokens in §5.2. When the sidecar changes, `webui/app/src/lib/api.ts`
changes with it.
