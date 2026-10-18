# Proof log: how things got proven (issue #2 run)

Luke asked for a record of every proving technique tried in this run: what worked, what failed, and what was creative, so it can feed back into how he runs the loop. Each entry: the claim, what was tried, the result, the lesson.

## Worked

### Cross-checking a library against an independent published source
- Claim: astral gives correct sunset times for the homelab's zone.
- Tried: astral 3.2 in a throwaway venv, printed to the second; compared with `api.sunrise-sunset.org` JSON for the same lat/lon/date/zone, including the first day after DST ends.
- Result: a consistent gap of +83 s at sunrise and -122 s at sunset, DST handled. The measured gap became a design rule (the UI shows HH:MM, never seconds).
- Lesson: "matches" is a claim; "differs by 122 s" is a measurement that changes the design.

### Headless Playwright full-page shots, sliced for reading
- Claim: the mockup looks right at desktop and phone, both themes.
- Tried: a 20-line Playwright script (`spikes/.../shoot.py`) at 1440 wide, `full_page=True`, toggled the theme by clicking, then sliced the 5,000-px-tall PNG into 1300-px strips with Pillow so each strip is legible when read as an image.
- Result: the agent saw defects a description would have hidden (orphaned edit button at 390px, wrapped 7th day chip, a green badge), and the proxy caught two more from the same images.
- Lesson: slice tall screenshots; one 5,000-px image downsamples to mush.

### A read-only baseline of the thing that must not break
- Claim: the deploy will not break wake-ramp.
- Tried: before any change, captured `crontab -l`, `wake-ramp status`, `govee-cli info --device "Light Bars"` (exit codes included) and an `ls --full-time` of `~/.config/govee-cli/` on pop-os into `/tmp/issue2-*-pre.txt`.
- Result: a diffable "before". The listing also exposed a `profiles/` directory nobody had mentioned.
- Lesson: a full-time `ls` of a state dir is a cheap detector for "something else writes here".

### Following the symlink before trusting "separate binary"
- Claim: wake-ramp is independent of this repo.
- Tried: `readlink -f ~/.local/bin/govee-cli`.
- Result: FALSE. It points at this repo's `.venv`, so every deploy changes the binary that wakes Luke at 06:30. That became grill choice G2 (deploy window, post-deploy smoke check).
- Lesson: resolve symlinks and shebangs for anything "unrelated".

### Real CLI in a throwaway HOME
- Claim: the lock refuses a second scheduler and names the owner; a dead owner reads stale.
- Tried: `HOME`/`USERPROFILE` pointed at `mktemp -d` and `GOVEE_API_KEY` emptied, so no real config or device could be touched. A background `python -c` held `SchedulerLock` for 12 s while `govee-cli daemon --once` ran, then `schedule list` ran before and after the holder exited.
- Result: `schedule owned by sidecar pid 50012 on gaming since 14:21`, exit 1, then `owner: nobody (stale since 14:21)` once the holder died without releasing. Three DoD lines settled by watching the real binary, with no test file.
- Lesson: an env-redirected HOME turns "would it touch my real config" into a non-question, so the real command can run freely.

### Measuring touch targets instead of eyeballing them
- Claim: no control is under 44 px on a phone.
- Tried: Playwright with `is_mobile=True, has_touch=True`. The script records `matchMedia("(pointer: coarse)")` in its output, so it proves the coarse-pointer CSS actually applied, then dumps the bounding box of every visible button/switch/input/link.
- Result: found timeline dots at 10x10 and 16x16 and a wake-ramp button at 8x26 that looked fine in the screenshot.
- Lesson: record that the emulation took effect (`pointer:coarse=yes`), or a 44 px pass means nothing.

### Env knobs to put the UI in states that are hard to reach
- Claim: the owner strip renders the stale, nobody and daemon states correctly.
- Tried: `GOVEE_WEBUI_MOCK_OWNER=stale|nobody|daemon` makes the mock seed an owner record (a dead pid for stale, the mock's own live pid for daemon), and `GOVEE_WEBUI_MOCK_NO_LOCATION=1` drops the location. verify_ui restarts only the sidecar per state and shoots each.
- Result: every state screenshotted. The stale shot showed a warning chip with a glyph, "pid 999999 is not running", and "stale since 16:26".
- Lesson: a state you cannot screenshot is a state nobody checked. Make it seedable.

### A cheap model as the adversary, aimed at past failures
- Claim: the build meets its definition of done.
- Tried: a Haiku `adversarial-reviewer` given the diff, the DoD and ten specific "this repo has been burned by" hunt targets.
- Result: it reproduced two high-severity bugs by running code. A device rule with an unregistered stored id resolves to the bedroom Light Bars over BLE, and an empty DIY list wipes the cache and claims "no longer exists". It also found five medium issues. Every agent's own tests had passed.
- Lesson: aim the adversary at named past failures. "Review this" gets style notes; "find a path where a stored id reaches BLE" gets the bug.

## Failed (and what replaced it)

### The in-app Browser pane for local mockups
- Tried: opening a `file://` mockup in the Browser pane.
- Result: page tools were refused on `file://`; served over `http://127.0.0.1` it worked but rendered 334 px wide, too narrow to judge a desktop layout.
- Replaced by: headless Playwright with an explicit viewport.

### WebFetch against timeanddate.com
- Tried: fetching sunset times as a reference.
- Result: HTTP 403.
- Replaced by: a JSON API (`api.sunrise-sunset.org`) via curl. Prefer machine APIs for reference data.

### zsh marker lines over SSH
- Tried: `echo ===STATUS===` inside an ssh command to separate sections.
- Result: zsh expanded `=STATUS` as a command lookup and the section was lost.
- Replaced by: writing each capture to its own file and `cat`-ing them. Avoid `=word` in remote zsh.

### Python `read_text`/`write_text` on Windows
- Tried: patching source files with a quick Python script.
- Result: the default cp1252 encoding wrote an em dash as byte 0x97; ruff and mypy then refused the file as invalid UTF-8. Caught by running the linters immediately, fixed by rewriting the byte.
- Lesson: on Windows always pass `encoding="utf-8"`, and run ruff/mypy right after any scripted edit. That run is the check that caught this.

## Failed (continued)

### Self-written assertion copy drifting from the UI
- Tried: verify_ui asserted "Schedule owner" on every owner state.
- Result: false failures for stale and nobody, whose headline is "No scheduler running". The screenshot proved the UI right and the check wrong.
- Lesson: when a check fails, look at the picture before fixing the code.

### Windows host zone
- Tried: mock screenshots on the Windows workstation.
- Result: `host_timezone()` cannot read an IANA name on Windows and falls back to UTC (by spec), so the shots showed "Today: 21:10 (sunset 22:10, host: UTC)". That is honest about itself, but it is not the production picture.
- Replaced by: `TZ=America/New_York` passed to the sidecar for shots, plus a re-shoot on pop-os after deploy.

### Windows console encoding, again
- Tried: printing a measured label containing `−` (U+2212).
- Result: `UnicodeEncodeError` (cp1252) killed the run halfway.
- Lesson: start every script with `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`, or run it with `PYTHONIOENCODING=utf-8`.
