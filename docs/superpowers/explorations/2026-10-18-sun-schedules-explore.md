# Sunset-relative schedules and light profiles: Exploration
Date: 2026-10-18 | Status: explored
Started from: GitHub issue iAmChumby/govee-cli#2, "I want lights to change mode on a daily schedule, where some times follow sunset instead of a fixed clock time, and a mode can set several devices at once."

Autonomous run: Luke delegated every question in this loop to a Luke-proxy agent (Opus, persistent context). Every "Said" below is the proxy's answer, marked with its confidence. Low-confidence proxy defaults are flagged so Luke can overturn them in his feedback pass.

### E1: astral as the sun-time source
- Question: does a proven library give correct sunrise/sunset for the homelab's zone, including DST and edge cases, or do we need our own solar maths?
- Tried: probe, `spikes/2026-10-18-sun-schedules/e1_astral_probe.py` (astral 3.2, Apache-2.0, only dependency `tzdata`), cross-checked against `api.sunrise-sunset.org` (timeanddate.com returned 403 to WebFetch).
- Saw: NYC (40.7128, -74.0060), America/New_York:
  - 2026-10-18: astral sunrise 07:10:45 / sunset 18:10:52; reference 07:09:22 / 18:12:54. Gap +83 s / -122 s.
  - 2026-11-01 (first day after DST ends): astral 06:26:38 / 16:51:56 EST; reference 06:25:12 / 16:53:59. Same gap, DST handled.
  - Tromso midsummer: astral raises `ValueError("Sun never reaches ... below the horizon")`.
- Said: n/a (probe).
- Means: astral is good enough for a minute-granular scheduler; the ~2 min disagreement with another published calculator is a fact to state, so the UI shows HH:MM and never seconds. Polar days raise, so "no sunset today" has to be a real state (rule does not fire, UI says why), never a guessed time.

### E2: mockup of rule editing, sun times, owner strip and the hand-authored room scene
- Question: what does authoring a profile (an editable room scene) and a sunset-relative rule look like inside the monochrome console?
- Tried: mockup, `spikes/2026-10-18-sun-schedules/e2-mockup.html` (Sonnet agent, tokens copied verbatim from `tokens.css`). Shot headless with Playwright at 1440 wide, full page, both themes: `spikes/2026-10-18-sun-schedules/shots/{dark,light}_{0..3}.png`. The Browser pane refused page tools on a `file://` URL, and over http it rendered only 334px wide, so headless Playwright was the instrument that worked.
- Saw: edit dialog with WHEN [Clock|Sunrise|Sunset] and an offset stepper, a resolved "Today: 17:10 (sunset 18:10, America/New_York)" line, and a no-location state that shows no time. TARGET [Device|Room scene]. Rule rows with an edit pencil and a server-side next run. Owner strip in three states (sidecar, daemon pid, nobody = warning with glyph + text, not colour only). The authored scene editor has per-device power, brightness and mode [Colour|White K|DIY] with per-model kelvin range, and a captured-unknown device shows "skipped on restore: mode unknown".
  Defects seen in the shots: at 390px the pencil in a long row wraps onto its own line, and the 7th day chip wraps to a second row.
- Backend facts that feed the design (recon): restore executor lives in `webui/api/routers/rooms.py:156-317`, so the CLI daemon can't replay a scene; no owner/lock concept anywhere; the browser computes next fire in browser-local time (`webui/app/src/app/schedules/next-fire.ts:20-41`) while the sidecar uses host time (`scheduler_runner.py:129`). Sunset rules need the next run computed once, server-side.
- Said (proxy, high): "The shape is right." One dialog for add and edit (Delete only in edit mode). The authored scene editor lives on the Rooms page; the rule dialog only picks a scene. Fixes: RUNNING badge neutral, not green (red stays for not-running and errors); rule-list day chips must show off-days as off; drop the duplicated "→ Evening (room scene)" line (medium). Keep the no-location state exactly that honest. Location: Settings section plus `govee-cli config`, lat/lon only, no geocoding, no network. Timezone unset = host zone, always labelled "host: <zone>" (medium, proxy default); validated against zoneinfo. No lat/lon default.
- Means: exploring is done; the remainder is build work.

## Direction

What spec-it starts from. Settled here; spec-it does not re-ask it.

### Goal
Schedule rules can fire at a clock time or at sunrise/sunset ± an offset, computed with astral from a lat/lon (and timezone, defaulting to the labelled host zone) set in Settings or `govee-cli config`; with no location a sun rule has no next run and says so. A rule targets either one device + command, or a room scene; room scenes can be hand-authored on the Rooms page (per-device power, brightness, colour / white K / DIY) as well as captured, and replaying one works from both the sidecar and `govee-cli daemon` through one shared executor in govee_cli. Every rule can be fully edited in one add/edit dialog (backed by a PUT route) and from the CLI. Next run is computed server-side and shown in `govee-cli schedule list` and the console, and the console shows which process owns the schedule (sidecar / daemon pid / nobody, with a stale heartbeat reading "stale since HH:MM", never "running") from a heartbeat+lock that also stops two schedulers running at once. Every new state file is redirected in both `tests/conftest.py` and `mock.py`. Deployed to pop-os and proven with real runs and screenshots at desktop and phone in both themes, and against live wake-ramp: `crontab -l` and `wake-ramp status` diffed identical before and after, nothing new fired on the bedroom lamp.

### Narrowed to
- Sun times: `sunrise±Nm` / `sunset±Nm` via astral, server-side next-run.
- Profiles = editable room scenes in `room-scenes.json`, `source: captured|authored`.
- Restore executor lifted from `webui/api/routers/rooms.py` into `govee_cli`.
- Rule target: device+command or room scene. Full edit via PUT and CLI.
- Owner heartbeat/lock file shared by sidecar and daemon.
- Location/timezone in config + Settings section + CLI.

### Ruled out
- Separate profiles store -> drifts from room scenes; issue says reuse if they cover it (proxy Q1).
- City geocoding / network lookup for location -> lat/lon is astral's input and needs no network (proxy Q2).
- Guessed default location -> no measured substitute exists; stays unknown (proxy Q2).
- Hand-rolled solar maths -> astral is within ~2 min of a published calculator (E1).
- Narrower scopes B/C -> would ship the issue without its main ask (proxy Q3).

### Learned
- astral 3.2 within ~2 min of sunrise-sunset.org for NYC, DST correct; polar days raise ValueError (E1).
- Restore executor is sidecar-only today; CLI daemon cannot replay a scene (E2 recon).
- No owner/lock concept; both schedulers could run concurrently (E2 recon).
- Browser computes next fire in browser-local time; sidecar in host time (E2 recon).
- Mock already redirects config.json and schedule.json; conftest does not (backend recon §9).
- The Browser pane cannot drive `file://` and renders at ~334px; headless Playwright full-page shots worked (E2).

### Still open
- Exact rule schema shape (`when` object vs `time` string grammar) and migration of existing rules.
- How "next change" is shown when several rules fire at the same minute.
- Whether the CLI daemon reloads rules (today it reads them once at startup).

### Spikes
- `spikes/2026-10-18-sun-schedules/e1_astral_probe.py`: astral accuracy probe. Reference only.
- `spikes/2026-10-18-sun-schedules/e2-mockup.html` + `shots/`: UI shape reference. Never merge.
