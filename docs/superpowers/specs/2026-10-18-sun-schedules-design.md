# Sunset-relative schedules and hand-authored room scenes
Date: 2026-10-18 | Status: walked (deployed to pop-os; PR #3 awaiting Luke's merge) | Explored: docs/superpowers/explorations/2026-10-18-sun-schedules-explore.md | Issue: iAmChumby/govee-cli#2

Autonomous run: Luke's answers come from a Luke-proxy agent. Proxy answers marked medium/low confidence are listed under "Proxy defaults Luke may overturn" at the bottom.

## Goal
Schedule rules can fire at a clock time or at sunrise/sunset ± an offset, computed with astral from a latitude/longitude (and a timezone that defaults to the labelled host zone) set in Settings or `govee-cli config`; with no location a sun rule has no next run and says so. A rule targets either one device + command, or a room scene. Room scenes can be hand-authored on the Rooms page (per-device power, brightness, colour / white K / DIY scene) as well as captured, and replaying one works from both the web console sidecar and `govee-cli daemon` through one shared executor in `govee_cli`. Every rule can be fully edited, in one add/edit dialog backed by a PUT route and from the CLI. Next run is computed server-side and shown in `govee-cli schedule list` and the console, and the console shows which process owns the schedule (sidecar / daemon with pid / nobody, with a stale heartbeat reading "stale since HH:MM", never "running"), from a heartbeat + lock that also stops two schedulers running at once. Deployed to pop-os, proven with real runs and screenshots at desktop and phone in both themes, and proven harmless to the live wake-ramp.

## Definition of done

Time grammar and sun maths
- `parse_time("sunset-1h")`, `"sunrise+30m"`, `"sunset-1h15m"`, `"sunset"`, `"06:30"` all parse; `"sunset+7h"`, `"sunset-361m"`, `"25:00"`, `"noon"`, `"sunset-1x"` are rejected with a message; `"sunset+0m"` → `sunset`, `"Sunset-90M"` → `sunset-1h30m`. (check: pytest `tests/test_timespec.py`)
- Every stored and displayed time is the canonical form (`sunset-1h15m`, never `sunset-75m`). Saving `sunset-75m` via CLI or API stores `sunset-1h15m`. (check: CLI add, then `cat` schedule.json)
- With location set to 40.7128, -74.0060, tz America/New_York, `next_run` for `sunset-1h` daily on 2026-10-18 at 12:00 is 2026-10-18 17:10 local (astral sunset 18:10:52 minus 1h, floored to the minute). (check: pytest)
- A polar date (69.65, 18.96, Europe/Oslo, 2026-06-21) yields no fire that day with reason `no sunset on 2026-06-21 at this location`, and the cycle does not raise. (check: pytest)
- A sun rule's `days` filter applies to the local date of the computed fire time, including when the offset crosses midnight. (check: pytest)
- DST, America/New_York: on 2026-11-01 (fall back) a clock rule at 01:30 fires exactly once; on 2027-03-14 (spring forward) a clock rule at 02:30 does not fire and shows `02:30 does not exist on 2027-03-14 (DST)`; a sun rule's next_run spanning a transition is correct. `last_fired_minute` is keyed on the UTC instant so the repeated hour cannot double-fire. (check: pytest)

Engine, firing and owner
- One engine function decides which rules are due; both `govee-cli daemon` and the sidecar runner call it. grep finds no other time-matching code. (check: `grep -rn "rule.time ==\|\.time ==" govee_cli webui/api` returns nothing outside the engine)
- A rule fires at most once per scheduled minute even across a reload or a 20s/30s poll, using `schedule-state.json` `last_fired_minute`. (check: pytest)
- A minute missed because no scheduler was running is not caught up; it is recorded and shown as `missed HH:MM` on that rule. Detection: on scheduler start, every enabled rule whose most recent scheduled minute lies after its `last_fired_minute` (or, if none, after the previous owner record's `last_cycle_at`) and before now is recorded as missed. A rule never fired with no prior owner record shows nothing, because claiming a miss would claim knowledge we lack. (check: pytest + console screenshot of a seeded missed state)
- The CLI daemon reloads rules every cycle (an edit while it runs takes effect without restart). (check: pytest on the reload path, or a run with `--once` after an edit)
- Starting a second scheduler while one holds the lock exits non-zero naming the owner (`schedule owned by sidecar pid 1234 on pop-os since 13:40`). (check: run `govee-cli daemon --once` while the sidecar owns it on pop-os, capture output and exit code)
- A heartbeat whose pid is gone, or older than 3 × poll_seconds, is reported as `nobody (stale since HH:MM)`, never as running. (check: pytest + console screenshot)
- `GOVEE_WEBUI_SCHEDULER=0` means the sidecar never takes the lock. (check: pytest)

Room scenes as profiles
- `room-scenes.json` entries carry `source: "captured" | "authored"`; old entries without it load as `captured`. (check: pytest with the existing file shape)
- An authored scene can be created and edited from the Rooms page and via `POST /rooms/authored` and `PUT /rooms/{name}`; captured scenes reject PUT with 409 and a message. (check: pytest + walk)
- Per authored device: power on/off; brightness 1-100; mode one of colour (hex), white (K within that model's `temp_min..temp_max` from `MODEL_SPECS`), or DIY scene (chosen from that device's live DIY list). A model without `cloud_diy` does not offer DIY. (check: grep the editor reads MODEL_SPECS-derived capabilities; walk)
- Restoring a scene goes through one executor in `govee_cli/room_restore.py`, used by `POST /rooms/{name}/restore`, by `govee-cli room apply NAME`, and by the scheduler. `webui/api/routers/rooms.py` keeps no send logic of its own. (check: grep)
- The executor checks `target.device_cfg is not None` before any send; an unregistered device id is skipped with reason `device not registered`, never sent over BLE. (check: pytest with a stale id; grep)
- Ledger is written only after a device's steps succeed; a ledger failure never fails the step. (check: pytest)
- Issue acceptance check 2 on real hardware: on pop-os after deploy, one test rule targeting an authored scene of non-bedroom devices (named before running, e.g. Shelf Lamp + Hall Lamp) fires from the sidecar; `govee-cli state` for each device before and after shows power, brightness, colour and K matching the scene. DIY steps are reported as `200 accepted, visual unconfirmed` (UNKNOWN), never as verified. Devices are put back to their prior state afterwards and the test rule deleted. (check: captured state output, before/after)

Rules targeting room scenes, editing
- A rule has exactly one target: `device`(optional) + `command`, or `room_scene`. Both or neither is rejected by CLI and API with a message. (check: pytest)
- A rule whose `room_scene` no longer exists shows `room scene 'X' missing: rule will not fire` in `schedule list`, the console row and the status view, and the scheduler logs it at fire time and sends nothing. (check: pytest + screenshot)
- Deleting a room scene that rules reference returns the referencing rule names; the console's delete confirmation lists them. (check: pytest + walk)
- `PUT /schedules/{id}` replaces name, time, days, target, enabled; validation is the same as POST. (check: pytest)
- `govee-cli schedule edit ID [--name] [--time] [--days] [--command] [--device] [--room-scene] [--enable/--disable]`, plus `enable ID` / `disable ID`. (check: run each against a temp config)
- Multi-word scene/DIY names in a device command still work (existing `" ".join(args)` behaviour kept). (check: pytest)

Location and timezone
- `config.json` gains `latitude`, `longitude`, `timezone` (all optional). `govee-cli config location LAT LON [--timezone ZONE]` and `govee-cli config location --clear`; `PATCH /config` accepts them; latitude in [-90, 90], longitude in [-180, 180], timezone must load with `zoneinfo.ZoneInfo`. (check: pytest + CLI run)
- Unset timezone means the host zone, displayed everywhere as `host: America/New_York`; a set zone displays bare. (check: CLI output + Settings screenshot)
- No location means every sun rule shows `no location: no next run` with a link to Settings in the console, and never a time. (check: screenshot + `schedule list` output)

Status, CLI output
- `govee-cli schedule list` prints per rule: id, enabled, canonical time, days, target, and next run as `Sun 18 Oct 17:10` or the reason it has none; a header line prints location, timezone (labelled) and owner. (check: run on pop-os after deploy, paste output)
- Times show HH:MM only, never seconds. (check: grep UI formatting + screenshots)

Console
- One dialog component handles add and edit; Delete appears only in edit mode. (check: grep there is no separate edit dialog; walk)
- Opening and saving a rule created from the CLI as `sunset-1h10m` keeps `sunset-1h10m`; the 15-minute stepper never rounds a stored value (it steps from it). (check: vitest on the dialog's time round-trip + walk)
- Rule rows show the canonical time, off-days visibly dimmed, target once (no duplicated target line), next run from the server, an edit button. (check: screenshots)
- Schedules page shows an owner strip in its three states; RUNNING is neutral chrome (no green); the nobody/stale state uses the warning treatment with a glyph and text. (check: screenshots of all three states via mock seeding)
- Settings has a Location section (lat, lon, timezone with the host default labelled). (check: screenshot)
- Rooms page offers "new scene" (authored) next to "capture scene"; authored cards show `authored`, captured cards `captured`. (check: screenshot)
- `scripts/verify_ui.py` passes with zero console errors on every route at 390x844; desktop 1440x900 and phone 390x844 screenshots, both themes, of Schedules (rule list, add dialog, edit dialog with sun time, no-location state), Rooms (authored editor), Settings (location). Every one is looked at, and none shows clipped text, a wrapped orphan control, a truncated honesty caption, or a touch target under 44px on phone. (check: screenshots read by an agent and by a second adversarial agent)
- Mobile-only changes use `max-md:`/`max-sm:`/`pointer-coarse:` only. (check: `viewport_audit.py --check` run on pop-os, where the baseline was made)
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `pytest`, `ruff check govee_cli webui/api`, `mypy govee_cli` are all green (baseline 2026-10-18 was fully green: pytest 495, vitest 329). (check: command output)

Safety (anti-criteria)
- Nothing in this work edits the crontab, `~/.local/bin/wake-ramp`, or fires any device during verification except an explicitly chosen test rule on a non-bedroom device. `crontab -l` and `wake-ramp status` captured before and after deploy diff identical. (check: diff output)
- Every new state file (`schedule-state.json`, `scheduler-owner.json` and its lock) is redirected in both `tests/conftest.py` and `webui/api/mock.py install()`. Running pytest does not change the mtime of any file in the real `~/.config/govee-cli/`. (check: grep + mtime before/after pytest)
- Mock mode sends nothing: the mock-mode runner holds the owner record as `sidecar (mock, dry run)` and records `would fire` instead of executing. (check: pytest + screenshot)
- No internal ids beyond the existing 8-char rule id appear in the UI; no seconds; no guessed time anywhere.

## Out of scope
- City/place geocoding, IP location, any network lookup for location.
- Dusk/dawn/twilight/solar-noon events (only sunrise and sunset).
- Catching up missed fires.
- Segments, music, firmware scenes or effects inside authored room scenes (captured scenes keep whatever they captured).
- Renaming room scenes.
- Migrating the wake-ramp crontab into native rules, or any change to how it is read.
- A systemd unit for `govee-cli daemon`.
- Per-rule timezones or per-rule locations.
- APScheduler-based rework.
- Changing H6183/v1 transport behaviour.

## Areas touched
- Time + engine + owner (Python core): `govee_cli/schedule/timespec.py` (new), `govee_cli/schedule/engine.py` (new), `govee_cli/schedule/owner.py` (new), `govee_cli/schedule/scheduler.py` (rule fields, atomic save), `pyproject.toml` (astral).
- Runners: `govee_cli/commands/daemon.py`, `webui/api/scheduler_runner.py`, `webui/api/main.py` (health/owner wiring), `webui/api/deps.py`.
- Room scenes + executor: `govee_cli/room_scenes.py` (source field, authored validation), `govee_cli/room_restore.py` (new, lifted from `webui/api/routers/rooms.py`), `webui/api/routers/rooms.py`, `govee_cli/commands/room.py` (new).
- Config: `govee_cli/config.py`, `govee_cli/commands/config.py` (or wherever `config` lives), `webui/api/routers/config.py`, `webui/api/schemas.py` (config + schedule + rooms models).
- Schedule API + CLI: `webui/api/routers/schedules.py`, `govee_cli/commands/schedule.py`.
- Test/mock isolation: `tests/conftest.py`, `webui/api/mock.py`.
- Console schedules: `webui/app/src/app/schedules/*` (page, add-rule-dialog → rule-dialog, timeline, next-fire.ts retired in favour of server values), `webui/app/src/lib/api.ts`, `webui/app/src/lib/queries.ts`.
- Console rooms: `webui/app/src/app/rooms/page.tsx`, `webui/app/src/components/rooms/*` (new authored editor dialog).
- Console settings: `webui/app/src/app/settings/*` (new location section), `webui/app/src/app/settings/sidecar.ts`.
- Verification scripts: `scripts/verify_ui.py` (new shots/states).

## Time grammar

```
time      := clock | sun
clock     := HH ":" MM                     00:00..23:59
sun       := event [ sign duration ]
event     := "sunrise" | "sunset"
sign      := "+" | "-"
duration  := hours "h" [ minutes "m" ] | minutes "m"
```
- Offset total must be 1..360 minutes (±6h). `sunset+0m` normalises to `sunset`. `sunset-90m` normalises to `sunset-1h30m`; `sunset-2h0m` to `sunset-2h`. Case-insensitive input, lowercase stored. Whitespace stripped.
- Resolution: compute the event for local date D in the configured (or host) zone with astral at elevation 0, add the offset, floor to the minute. The fire's local date is the date whose `days` filter applies. To find the next run, scan D = today..today+8.
- astral `ValueError` (no event that day) → no fire that day, reason `no sunrise|sunset on YYYY-MM-DD at this location`.
- astral is ~2 min off another published calculator (E1); UI copy never implies more precision than the minute.

## Data

`schedule.json` rule (backwards compatible; unknown keys still ignored on load):
```json
{"id": "a1b2c3d4", "name": "Evening", "time": "sunset-1h", "days": ["mon", ...],
 "command": "", "enabled": true, "device": null, "room_scene": "Evening"}
```
Existing rules have no `room_scene` and load as device rules. Saves become atomic (tmp + `os.replace`), using `filelock.py`.

`schedule-state.json` (new): `{rule_id: {last_fired_minute, last_result: ok|error|missed|skipped|would_fire, last_detail, missed_minute}}`. Written by whichever scheduler owns the lock. Never fsync'd (same reasoning as the request meter).

`scheduler-owner.json` + `scheduler-owner.json.lock` (new): lock held for the life of the scheduler; record `{kind: sidecar|daemon, dry_run, pid, host, started_at, last_cycle_at, poll_seconds}` rewritten every cycle. Readers report `running` only if the pid is alive on this host and `now - last_cycle_at <= 3 × poll_seconds`; otherwise `stale since <last_cycle_at HH:MM>`; no file → `nobody`.

`room-scenes.json` scene gains `source`. Authored devices use the existing `CapturedDevice` shape: `mode: "off"` (power off), `"basic"` with `color` or `color_temp_k`, or `"diy"` with `label` = DIY name and `payload = {"diy_value": n}`; `brightness` always set.

`config.json` gains `latitude`, `longitude`, `timezone`, all nullable.

## API

- `GET /schedules` → `{schedules: [rule + {next_run: iso|null, next_run_reason: str|null, last: {...}|null, target_problem: str|null}], owner: {...}, location: {latitude, longitude, timezone, timezone_source: "config"|"host"}}`.
- `POST /schedules`, `PUT /schedules/{id}` share one request model; `PATCH /schedules/{id}` stays (enabled only) for the row switch.
- `POST /rooms/authored` `{name, devices: [...]}`; `PUT /rooms/{name}` (authored only, 409 for captured); `DELETE /rooms/{name}` response adds `referenced_by: [rule names]` (the UI asks first via `GET /rooms/{name}/references`).
- `GET/PATCH /config` gain the three location fields.
- Health keeps its current shape and adds `scheduler.native.owner`.

## CLI
- `govee-cli schedule list|add|edit|enable|disable|remove` (add/edit accept `--room-scene`).
- `govee-cli room list` and `govee-cli room apply NAME` (prints per-device result incl. skipped reasons).
- `govee-cli config location LAT LON [--timezone ZONE]`, `--clear`, and bare `govee-cli config location` prints the current value.
- `govee-cli daemon` takes the lock or exits 1 naming the owner.

## Console UI
- Rule dialog (one component, add + edit): Name; WHEN segmented `Clock | Sunrise | Sunset` + time input or offset stepper (15-minute steps, before/after), resolved line `Today: 17:10 (sunset 18:10, host: America/New_York)` from a server preview, or the no-location line; DAYS chips that fit one row at 390px; TARGET segmented `Device | Room scene`; Device → device select + command field with quick picks; Room scene → scene select + `4 devices · authored`. Footer: Delete (edit only, two-step like today), Cancel, Save.
- The resolved-line preview comes from a small `POST /schedules/preview {time, days}` → `{next_run, event_time, reason}` so the browser never does sun maths.
- Rule row: switch, name + target subline, canonical time, day chips with off-days dimmed, next run or reason (data-volatile), edit button with a 44px hit area on coarse pointers; no orphan wrap at 390px.
- Owner strip at the top of Schedules: neutral chip + text; warning treatment for nobody/stale; shows the next change (all rules sharing that minute).
- Rooms: "new scene" opens the authored editor (per-device rows from the registered devices; add/remove devices). Authored cards get an edit action. Delete warns with referencing rules.
- Settings: Location section (lat, lon, timezone input with `host: <zone>` placeholder, clear button).
- Design per `WEBUI_SPEC.md` §5.2/§5.5: monochrome chrome, Archivo/IBM Plex Mono, colour only as device light content, captions wrap and never truncate.

## Error handling
- A rule whose target fails at fire time records `error` with the message, visible on the row; the cycle continues with other rules.
- A room scene restore records per-device ok/skipped/error; the rule's last result is `ok` only if every non-skipped device succeeded, else `error` with the count.
- Unreadable `schedule-state.json` or owner file is treated as absent and reported as unknown in the UI, never as "fine".

## Proxy defaults Luke may overturn
- Timezone unset defaults to the host zone, labelled `host:` (medium).
- No catch-up of missed fires; shown as `missed HH:MM` (medium).
- The duplicated target line in the rule row is dropped (medium).

## Grill choices

These win over everything above them, including the body. Answers from the Luke-proxy agent; capture file `transcripts/2026-10-18-sun-schedules-grill.md`.

### G1. A restarted sidecar waits for the owner lock; it never steals it
It retries every poll cycle and the owner strip says "waiting for lock held by <owner>". Only a lock that is actually held blocks; a stale heartbeat file never does. kill -9 of the owner lets the waiting sidecar take over within one cycle (tested). `govee-cli daemon` started while the lock is held exits 1 naming the owner.

### G2. Deploy safety around wake-ramp
wake-ramp runs `~/.local/bin/govee-cli`, which is this repo's venv. Never deploy between 06:15 and 06:45. The venv install (astral) completes before the restart. After deploy: `~/.local/bin/govee-cli info --device "Light Bars"` exits 0, and `wake-ramp status` plus `crontab -l` diff identical to the pre-deploy capture. Light Bars is never a test target.

### G3. The timeline plots from a server `today_fire`, not `next_run`
`GET /schedules` adds `today_fire` (today's computed minute, past or future, or null + reason). The timeline does no time maths. Sun dots carry a monochrome glyph and a tap/inline label ("sunset −1h · 17:10"), never title-only, and `data-volatile="true"`. Unplottable rules are summarised as "N rules not on today's timeline" with short reasons (wraps). No sunrise/sunset markers.

### G4. Settings and the owner strip share one formatter
Both read the one owner record and render identical strings (vitest asserts it for every state). No UI reads `health.scheduler.native.alive`; the field stays, with a comment. "last fire" = HH:MM + rule name; "none yet" only when the state file says so; "unknown" if unreadable.

### G5. DIY steps send the stored value only after verifying it exists
For captured and authored scenes alike: the stored `diy_value` must appear in the device's DIY list (live or the disk cache, the result naming "verified against list cached HH:MM"). Renamed → sent, with a note. Gone → step error "DIY scene 'X' no longer exists on <device>". List unavailable and no cache → "could not verify DIY scene 'X' on <device>: list unavailable", nothing sent, never blind. The device's other steps still run (medium).

### G6. Partial device failure clears that device's ledger to unknown
If any step for a device fails, `ledger.clear_mode` runs for it and the result says "ledger cleared: partial apply". A full success records the mode as before.

### G7. Authored scene membership: include switches, neutral defaults
Every registered device is a row with an include switch, off by default. Included rows start at power on, brightness 50, white at max(2700, temp_min), never prefilled from reported state. A device the API reports offline is labelled "offline" and can still be included (medium), with a caption that it will error at apply while offline. Save needs at least one device and says why inline when disabled.

### G8. Requests go through the existing meter
Every restore step and DIY-list check goes through `GoveeHTTPv2._request`; no new meter hooks, no budget percentages. A 429 during a scheduled restore shows as that device's error with the retry count.

### Open flags
- none

### Durable
- CLAUDE.md (govee-cli, "Do not break wake-ramp"): Deploys touch wake-ramp's binary (`~/.local/bin/govee-cli` → repo `.venv`). Never deploy 06:15-06:45; after deploy run `govee-cli info --device "Light Bars"` and diff `wake-ramp status`.
- CLAUDE.md (govee-cli): The schedule has one owner, held by `scheduler-owner.json.lock`. A heartbeat is evidence only while its pid is alive and fresh; otherwise report "stale since HH:MM".

## Rig

How this gets built. build-it follows it as written.

### Spine
Built by the main agent before any agent starts. Agents build against it and never edit it.
- Rule shape + state shapes in `govee_cli/schedule/scheduler.py` (`ScheduleRule.room_scene`, `RuleState`, `SCHEDULE_STATE_PATH`, function signatures for state read/write and `update_rule`). Used by core, runners, schedule API/CLI, mock/tests.
- Time API in `govee_cli/schedule/timespec.py` (`TimeSpec`, `parse_time`, `canonical`, `Location`, `resolve_location`, `fire_time_on`) — signatures only. Used by core, runners, schedule API/CLI.
- Engine API in `govee_cli/schedule/engine.py` (`RuleStatus`, `rule_status`, `due_rules`, `detect_missed`) — signatures only. Used by core, runners, schedule API/CLI.
- Owner API in `govee_cli/schedule/owner.py` (`OwnerRecord`, `OwnerView`, `OWNER_PATH`, `OWNER_LOCK_PATH`, `SchedulerLock`, `read_owner`) — signatures only. Used by core, runners, schedule API/CLI, mock/tests.
- Restore API in `govee_cli/room_restore.py` (`DeviceResult`, `SceneResult`, `restore_scene`) and `RoomScene.source` in `govee_cli/room_scenes.py`. Used by room executor, runners, rooms API.
- Config fields `latitude`, `longitude`, `timezone` on `GoveeConfig` in `govee_cli/config.py`. Used by core, config API/CLI, schedule API.
- All new/changed pydantic models in `webui/api/schemas.py`. Used by schedule API, config API, rooms API.
- Frontend types, fetchers and query hooks in `webui/app/src/lib/api.ts` and `webui/app/src/lib/queries.ts`, plus `webui/app/src/lib/schedule-format.ts` (the one owner/time formatter G4 requires). Used by schedules UI, rooms UI, settings UI.

### Areas
| Area | Files | Built by | Model | Runs |
|---|---|---|---|---|
| Core time/engine/owner | `govee_cli/schedule/{timespec,engine,owner,scheduler}.py`, `govee_cli/filelock.py` (add non-blocking try-lock), `pyproject.toml`, `tests/test_timespec.py`, `tests/test_schedule_engine.py`, `tests/test_scheduler_owner.py` | general-purpose | sonnet (DST, lock semantics) | first, background |
| Runners | `govee_cli/commands/daemon.py`, `webui/api/scheduler_runner.py`, `webui/api/main.py`, `webui/api/deps.py`, `tests/test_scheduler_runner.py` | general-purpose | sonnet (lock wait loop, dry-run) | first, background |
| Room executor + CLI | `govee_cli/room_scenes.py`, `govee_cli/room_restore.py`, `webui/api/routers/rooms.py`, `govee_cli/commands/room.py`, `govee_cli/cli.py`, `tests/test_room_restore.py`, existing room tests | general-purpose | sonnet (lifting send logic, DIY verification, BLE guard) | first, background |
| Config + schedule API/CLI | `govee_cli/commands/config.py`, `webui/api/routers/config.py`, `webui/api/routers/schedules.py`, `govee_cli/commands/schedule.py`, `tests/test_schedules_api.py` | general-purpose | haiku (routes and Click commands against spine schemas) | first, background |
| Test/mock isolation + seeding | `tests/conftest.py`, `webui/api/mock.py` | general-purpose | sonnet (safety-critical; real state has been overwritten twice) | first, background |
| Schedules UI | `webui/app/src/app/schedules/*` | general-purpose | sonnet (visual judgment) | first, background |
| Rooms UI | `webui/app/src/app/rooms/page.tsx`, `webui/app/src/components/rooms/*` | general-purpose | sonnet (visual judgment) | first, background |
| Settings UI | `webui/app/src/app/settings/*` | general-purpose | haiku (one form section + rows via shared formatter) | first, background |
| verify_ui shots | `scripts/verify_ui.py` | general-purpose | haiku | after the three UI areas, background |

`cli.py` registration for `room` belongs to the room area; the config area registers nothing new in `cli.py` unless `config` is not already a group (it then tells the main agent).

### Delegation
- Builders: subagents from the main agent.
- Model override, logged: Luke's live instruction ("Haiku does a lot of the work and the adversarial review") wins over the global CLAUDE.md split the proxy cited. Adversarial review runs on Haiku `adversarial-reviewer` agents; a Haiku report that is wrong or thin is rerun on Sonnet and said so in chat. Test/mock isolation went to Sonnet on the proxy's safety argument.
- Keeps going: no; one pass, then walk-it (autonomous run, no user stop).
- Briefs carry, on top of build-it's list: edit files only with Read/Edit/Write; never start servers or run the full build (the main agent runs the gates); never write to the real `~/.config/govee-cli/`; never send to real devices; Windows host with Git Bash, venv at `.venv/Scripts/python`; Luke's honesty rules (unknown stays unknown, no seconds, no litotes, captions wrap); mobile-only changes via `max-md:`/`pointer-coarse:` only; `cn()` has no merge, visibility on wrappers; test by doing, focused tests only for pure logic named in the DoD.
- Helpers: Haiku agents mine long test/build logs; Haiku runs greps, mtime and diff checks.
- Gaps go back to the same agent with `SendMessage`. An interrupt stops the reply, never the agents.

### Process
- Branch: existing worktree branch `feat/issue-2-sun-schedules` at `C:\Users\Luke\Projects\govee-cli-issue2`.
- Commits: main agent commits per area after checking it, with the attribution trailer.
- Stops: straight through to the end pass.
- Fixes mid-build: background agent, the same one that owns the file.
- Gates (end pass, main agent): `pytest`, `ruff check govee_cli webui/api`, `mypy govee_cli`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` (no dev server running), `scripts/verify_ui.py`, then a real-config mtime check around pytest.
- Docs: after the end pass, CLAUDE.md (scheduler owner/lock, deploy-vs-wake-ramp window, time grammar, new state files in the redirect list) and the `webui/README.md` schedules section. Short and factual.

## Build log
Date: 2026-10-18 | Agents: 9 build areas (Sonnet: core, runners, room, test/mock, schedules UI, rooms UI; Haiku: config+schedule API/CLI, settings UI, verify_ui) + Haiku reviewers (1 adversarial, 2 screenshot sweeps) + Opus Luke-proxy

### What landed
- **Time + engine + owner** (`govee_cli/schedule/{timespec,engine,owner,scheduler}.py`, `govee_cli/filelock.py`): canonical time grammar, astral sun times, one due-rule engine with UTC minute keys, missed detection with `baseline_at`, non-blocking owner lock + heartbeat.
- **Runners** (`govee_cli/commands/daemon.py`, `webui/api/scheduler_runner.py`, `main.py`, `deps.py`): one firing path for both; daemon refuses when the lock is held; sidecar waits; mock = dry run; unregistered stored ids never reach BLE.
- **Room scenes** (`govee_cli/room_scenes.py`, `govee_cli/room_restore.py`, `webui/api/routers/rooms.py`, `govee_cli/commands/room.py`): shared executor, authored scenes, DIY verification, `room list|apply|import-profiles`.
- **API/CLI** (`webui/api/routers/{schedules,config}.py`, `govee_cli/commands/{schedule,config_cmd}.py`): full edit (PUT), preview, owner/location in GET, `config location`.
- **Console** (`webui/app/src/app/{schedules,rooms,settings}/*`, `components/rooms/*`, `lib/{api,queries,schedule-format}.ts`): one add/edit dialog with sun times, owner strip, server-timed timeline, authored scene editor, Location section, shared owner formatter.
- **Verification** (`scripts/verify_ui.py`, `tests/conftest.py`, `webui/api/mock.py`): desktop + interaction + owner-state + no-location + touch-measure passes; every state file redirected.

### Definition of done
| Line | State | Evidence |
|---|---|---|
| Grammar parses/rejects/normalises | TRUE | `tests/test_timespec.py`; reviewer ran all 14 examples |
| Canonical form stored | TRUE | CLI temp HOME: `--time sunset-75m` → stored `sunset-1h15m` |
| NYC sunset-1h → 17:10 on 2026-10-18 | TRUE | `tests/test_schedule_engine.py`; mock UI "Today 17:10 (sunset 18:10)" |
| Polar day: no fire, reason, no raise | TRUE | `tests/test_timespec.py` |
| days apply to fire's local date across midnight | TRUE | `tests/test_schedule_engine.py` (Oslo cases) |
| DST fall-back once / spring-forward gap reason / sun across DST | TRUE | `tests/test_schedule_engine.py` (20 s polling simulation) |
| One engine decides due rules | TRUE | `grep -rn "rule.time ==" govee_cli webui/api` → empty |
| At most once per minute (incl. failed state write) | TRUE | engine + runner tests (F7) |
| Missed recorded, not caught up; no false "missed" | TRUE | engine/runner tests (F8, F9); mock screenshot shows "missed" |
| Daemon reloads rules every cycle | TRUE | `tests/test_scheduler_runner.py` |
| Second scheduler exits non-zero naming owner | TRUE | pop-os: `schedule owned by sidecar pid 560153 on pop-os since 15:02`, exit 1 |
| Dead/old heartbeat reads stale, never running | TRUE | temp-HOME CLI run (`nobody (stale since 14:21)`); owner tests; screenshot |
| `GOVEE_WEBUI_SCHEDULER=0` never takes the lock | TRUE | TestClient run: `this_process=disabled`, no lock or owner file created |
| `source` on room scenes; old entries = captured | TRUE | pop-os `room list`: `Day Time source=captured` |
| Authored POST/PUT; captured PUT 409 | TRUE | `tests/test_rooms_api.py::TestAuthored`; live POST on pop-os |
| Per-device power/brightness/colour/white-in-range/DIY | TRUE | route validation tests; editor screenshots |
| One executor; rooms router has no send logic | TRUE | reviewer grep |
| `device_cfg` guard (scenes AND device rules) | TRUE | `tests/test_room_restore.py`; F1 test (8-octet id, BLE patched to raise) |
| Ledger only after success; failure clears (G6) | TRUE | room_restore tests |
| Acceptance 2 on real hardware | TRUE | pop-os 15:06: rule fired, Shelf 35%/4000K + Hall 40%/#00A0FF read back exactly; restored after |
| ↳ DIY step of the restore scene | UNKNOWN | 200 accepted; device reports "" for DIY. Settler: Luke glances at Shelf Lamp (flame effect = Dark-soho) |
| Exactly one target (CLI + API) | TRUE | CLI error text; `tests/test_schedules_api.py` |
| Missing room scene message everywhere | TRUE | verify_ui text assertion; engine tests |
| Delete warns with referencing rules | TRUE | references route test; card wiring (agent report, not screenshotted with references) |
| PUT full edit; CLI edit/enable/disable | TRUE | `tests/test_schedules_api.py` (54) |
| Multi-word scene/DIY names kept | TRUE | `tests/test_schedules_api.py` |
| Location config/CLI/PATCH validation | TRUE | temp-HOME CLI run; API tests |
| Unset tz labelled `host:` | TRUE | pop-os `schedule list`: `timezone: host: America/New_York` |
| No location → no time, Settings link | TRUE | noloc screenshots + assertion; live strip |
| `schedule list` header + per-rule next run on pop-os | TRUE | pop-os during hw test: `[✓] 6b64ffa6 15:06 Sun → room scene 'issue2-test' next: Sun 18 Oct 15:06` |
| HH:MM only | TRUE | clock times only HH:MM; durations keep seconds (Guess G-a) |
| One add/edit dialog | TRUE | `add-rule-dialog.tsx` deleted |
| `sunset-1h10m` round-trips | TRUE | `when.test.ts` |
| Rule rows, owner strip states, Settings location, Rooms new scene | TRUE | verify_ui screenshots (62) + live shots (12) |
| verify_ui: zero console errors, no clipping, ≥44px on phone | TRUE | run 6 exit 0; measure 0 under 44px with `pointer:coarse=yes`; 2 Haiku sweeps |
| Mobile changes only via max-*/pointer-coarse; viewport_audit on pop-os | TRUE (mobile) / see note | pop-os audit: mobile 0 hard failures both themes. Desktop diffs only on the 3 changed routes beyond pre-existing drift: clean origin/main already shows 172 diffs (home 79, device 68, schedules 25) |
| All gates green | TRUE | pytest 664, ruff, mypy ×2, tsc, eslint, vitest 366, next build (pop-os deploy) |
| crontab + wake-ramp diff identical; info Light Bars exit 0 | TRUE | pop-os pre/post captures |
| New state files redirected; real config untouched by pytest | TRUE | conftest/mock; Windows mtime diff empty; pop-os: only the live sidecar heartbeat changed |
| Mock sends nothing | TRUE | dry-run short-circuit tests; BLE refused in mock (F6) |

### Gates
pytest 664 passed (Windows and pop-os/Linux) · ruff clean · mypy govee_cli + webui/api clean · tsc clean · eslint clean · vitest 366 passed · `next build` (pop-os deploy) ok · verify_ui `--owner-states --no-location --tz America/New_York` all checks passed.

### Guesses
- G-a durations keep seconds; G-b sleep-mode Light Bars skipped as ambiguous; G-c location left unset (Luke's data); G-d DIY failure lets other steps run; G-e `--text-low` contrast is an app-wide follow-up; G-f desktop baseline already stale, not re-baselined; G-g merge blocked by the auto-mode classifier.
- `next-fire.ts` kept (the external crontab panel still uses it).
- `room import-profiles` uses the registry's model, not the file's.

### Changed on request
- Profiles dir found mid-build → `room import-profiles` (proxy, Luke's stand-in) and run on pop-os: day, relax, sleep mode imported.

## Walk 1
Date: 2026-10-18

Later entries here win over everything above, including Grill choices. Walked on the live pop-os deployment from screenshots and measurements; the Luke-proxy answered.

### W1. Guesses G-a..G-g
- Shown: the build log's guesses, with live screenshots of Schedules, Rooms and Settings at 390 and 1440 in both themes.
- Said: keep G-a, G-c, G-d, G-g. G-b change: keep the skip, but put the reason on the scene. G-e and G-f become follow-ups; "do not re-baseline in this PR".
- Decided: imported scenes record skipped devices in their note. The viewport_audit DoD line stays UNKNOWN until issue #5 re-baselines. The contrast token is tracked as issue #4.
- Fix: inline.

### W2. Phone status strip
- Shown: the poll chip was cut at the 390px edge on every route.
- Said: "a clipped control fails the no-nits bar", fix under max-md.
- Decided: below md the strip reads "sidecar" and "scheduler". Measured live: the poll chip spans x=244..312 inside 390, both themes, all routes. Desktop is unchanged.
- Fix: inline.

### W3. Status strip dot source
- Shown: a green "native scheduler" dot.
- Said: check that it reads the owner, not `alive`.
- Decided: it already reads `owner.state === "running"` (`grep -rn "\.alive" webui/app/src` shows only a comment). No change.
- Fix: none, it was right.

### W4. Last fire of a deleted rule
- Shown: Settings "LAST FIRE 15:06 deleted rule 6b64ffa6".
- Said: record the name at fire time.
- Decided: fires record `rule_name`. A deleted rule shows "<name> (rule deleted)". The 15:06 test fire predates the field and honestly keeps the id fallback. Proven by a dry-run cycle: `rule_name= named-fire`.
- Fix: inline.

### W5. Settings owner row repeats its label
- Shown: label "SCHEDULE OWNER" followed by "Schedule owner: web console sidecar".
- Decided: Settings uses `withoutOwnerSubject(formatOwner(...))`, still the one formatter. The Schedules strip keeps the prefix.
- Fix: inline.

### W6. Sleep mode note looked blue
- Shown: light desktop Rooms.
- Decided: measured computed colours. Every note is the same `text-low` (rgb 92,97,103 dark; 138,143,150 light). The tint is the card's device-colour bleed, which is intended light content. No change.
- Fix: none, it was right.

### Fixes applied
- W1: skipped devices appended to imported notes (`govee_cli/commands/room.py`); live "sleep mode" re-imported through the command - inline
- W2: phone-only labels (`webui/app/src/components/shell/status-strip.tsx`) - inline
- W4: `RuleState.rule_name` (`govee_cli/schedule/scheduler.py`, `govee_cli/commands/daemon.py`, `webui/api/routers/schedules.py`) - inline
- W5: `withoutOwnerSubject` (`webui/app/src/lib/schedule-format.ts`, `webui/app/src/app/settings/connection-owner.ts`) - inline
- Also found live and fixed: the heartbeat age is now measured server-side (`last_cycle_age_seconds`), because minute-floored timestamps made it read "1m ago" for a 20s heartbeat
