# Sun schedules + authored room scenes: Grill Notes
Date: 2026-10-18 | Grilling: docs/superpowers/specs/2026-10-18-sun-schedules-design.md

Answers come from the Luke-proxy agent (autonomous run).

Facts gathered before Q1 (pop-os, 2026-10-18):
- wake-ramp drives only `DEVICES=("Light Bars")` (`~/.local/bin/wake-ramp:30`) via `~/.local/bin/govee-cli`, a symlink to `~/projects/govee-cli/.venv/bin/govee-cli`, i.e. the repo being deployed. Crontab: `30 6 * * * wake-ramp run` (daily).
- `schedule.json` holds 0 rules. `room-scenes.json` holds 1 scene, "Day Time" (captured; H6022, H6056, H6008×2, all `basic`).
- `deploy/install-services.sh` runs `pip install -e ".[webui]"`, rebuilds, and restarts both units; no sudo.

### Q1: sidecar restart while the owner lock is held
- Asked: when a restarted sidecar finds the owner lock held, what does it do?
- Answer: A. Retry every poll cycle, show "waiting for lock held by <owner>", never steal. The OS releases a dead owner's lock; a stale heartbeat file alone never blocks. Test: kill -9 the owner, the waiting sidecar takes over within one cycle. The daemon stays asymmetric: started while held, it exits 1 naming the owner. Added safety: never deploy 06:15-06:45; after deploy run `~/.local/bin/govee-cli info --device "Light Bars"` (exit 0) and diff `wake-ramp status`; confirm the venv install (astral) finished before the restart. (high)
- Flags: none

### Q2: sun rules on the Schedules timeline
- Asked: the timeline matches the "HH:MM" string; how do sun rules appear?
- Answer: A, corrected. The API adds `today_fire` (today's computed minute, past or future, or null + reason), never derived from next_run (a fired rule's next_run is tomorrow). The timeline plots every rule from `today_fire` and does no time maths. Sun dots get a monochrome glyph and a label reachable by tap/inline ("sunset −1h · 17:10"), never `title=`-only. Unplottable rules are summarised as "N rules not on today's timeline" with short reasons, wrapping. Sun dots carry `data-volatile="true"`. No sunrise/sunset markers (C skipped, medium). (high)
- Flags: none

### Q3: Settings scheduler rows vs the owner strip
- Asked: Settings shows thread `alive` as "running", which can contradict the owner lock. What do both show?
- Answer: A. Both read one owner record through one shared formatter, identical wording; a vitest feeds every owner state through it and asserts Settings and the strip render the same string. grep finds no UI reader of `alive`; the field stays in the payload with a comment saying why. "last fire" = HH:MM + rule name, "none yet" only when the state file says so, "unknown" when unreadable. (high)
- Flags: none

### Q4: DIY step resolution in a room scene
- Asked: a DIY scene may be renamed/deleted after authoring; how does a restore send it?
- Answer: A. Send by stored `diy_value`, after verifying it is in the device's live DIY list; a renamed one reports "DIY 'old' is now named 'new'"; a gone one errors "DIY scene 'X' no longer exists on <device>" and sends nothing for that step. Applies to captured scenes too (one executor). List unavailable with no cache → "could not verify DIY scene 'X' on <device>: list unavailable", nothing sent, never blind; a cached list counts and the line says "verified against list cached HH:MM". Other steps for that device still run (medium); device result = error; DIY mode never recorded in the ledger. (high)
- Flags: exact ledger state after a partial device failure → confirmed in Q5

### Q5: ledger after partial failure; authored scene membership
- Asked: (confirm) clear the ledger to unknown after a partial device failure? Then: how does a device join an authored scene?
- Answer: Confirm YES, result line says "ledger cleared: partial apply" (high). Membership: A. Every registered device is a row with an include switch, off by default; included rows start at neutral defaults within the model's range (power on, brightness 50, white at max(2700, temp_min)), never prefilled from reported state. Offline devices (only when the API actually reports offline) are labelled "offline", can still be included, and the caption says it will error at apply while offline; wraps, no tooltip (medium). Save needs ≥1 included device and says why inline when disabled. (high)
- Flags: none
