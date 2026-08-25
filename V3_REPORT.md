# filament v3 — what changed and why

Session of 2026-08-25. Everything below is on `main` and pushed; CI is green;
the console is deployed and running on `https://100.121.176.1:6056`.

---

## The short version

You raised four things. All four had a root cause worth naming, and three of
them were the same root cause wearing different clothes: **the console was
stating things it had no way to know.**

| What you said | What was actually happening |
|---|---|
| "the lights in the GUI don't really match what I see in real life" | The Govee cloud reports `""` for every scene field on every model, always — while still returning a stale `colorTemperatureK` from before the scene started. Your shelf lamp reported "2700K" while visibly running a blue/magenta morph, and the UI drew exactly what it was told. |
| "I want that lava lamp motion in the GUI" | Nothing in the console could animate. Every instrument was a static colour. |
| "I have a schedule... I don't see that in the UI, but it is still happening" | The page was telling the truth: `schedule.json` really is empty. The 06:30 ramp is a **crontab** line running `wake-ramp`, which the console had no idea existed. |
| "the segment editing is terrible" | It was a select-a-segment-then-apply rail over a 15-slot address space, on a lamp that is really a 132-LED matrix. |

And separately: **CI had been red since before the web console existed.**

---

## CI: green, and the reason it wasn't

`requests` is imported by `http.py` and `http_v2.py` and was **never declared as
a dependency**. Every venv on your machine had it pulled in by something else; a
clean GitHub runner did not — so `import govee_cli` failed there, killing both
the test job and the `--help` smoke test, while the CLI worked perfectly locally.
That is why it could stay broken for months without you noticing anything wrong.

Three more breaks in the same pass:

- `tests/test_webui_api.py` imports `fastapi`, which lives in the `[webui]`
  extra CI never installed. One collection error takes the whole run down.
- 4 mypy errors and 5 ruff errors that had accumulated.
- 1,255 committed `venv/` files — 86% of the tracked tree — now removed.

CI now also builds, lints, type-checks and **tests** the frontend, so a broken
console fails the build instead of only failing in production.

---

## 1. The console now knows what the room is doing

The cloud will never tell us what scene is playing. So `govee_cli/ledger.py`
keeps a durable local record of what *we* last commanded
(`~/.config/govee-cli/active-mode.json`), written by every mutating path in
**both** the CLI and the sidecar — so a scene you set from the terminal and one
you set from your phone agree.

The part that matters most is what it does when it doesn't know. **No entry means
`unknown`, and `unknown` renders no scene, no motion, and no guess.** There is a
reset control on every stage for when the console is wrong, because you can
always change a light from the Govee app and we will never see it.

Verified live: the shelf lamp went from being drawn as flat warm white to
reporting `diy · sleep · assumed · 2h ago`, and back to `unknown` after a reset.

Confidence is computed at read time, never stored — `confirmed` when live state
still matches what we set, `assumed` when we can't corroborate, `external` when
the device has drifted from our record.

## 2. Motion

A Canvas2D engine (`webui/app/src/lib/motion-engine/`) drives every instrument
from one module-level ticker. Scene names resolve to an archetype and palette
through four layers: curated overrides, then keywords, then a colour word in the
name, then a stable hash — so an arbitrary DIY name like `FRoesy2k` still
animates rather than falling back to nothing.

Your `sleep` scene is a curated override: slow blue→magenta blobs, 60s period.
That's the lava lamp.

Two things worth flagging because they were bugs I hit and fixed:

- The archetypes that fill their region edge to edge were painting a **hard-edged
  rectangle** of colour with the lamp silhouette floating on top. Regions now
  clip to the instrument's actual shape, so it reads as the fixture emitting
  rather than a coloured card behind it.
- The dashboard card's ambient tint was reading the cloud's stale temp, so a card
  glowed **amber around a purple lamp** — the original mismatch reproduced one
  element out. It reads the motion palette now.

Nothing subscribes at all under `prefers-reduced-motion`.

## 3. Paint Studio

Replaces the segments rail. A 12×11 wrapped-cylinder canvas — the lamp's real
geometry, column 11 adjacent to column 0 — with drag painting, flood fill,
gradient, symmetry, eyedropper, undo/redo, and a direction-of-motion control.

The honest part, and the reason this is genuinely better than the app rather than
just prettier: cloud v2 exposes **15 linear segments** over 132 LEDs, and is rate
limited to about 2 writes/second. So the studio shows **what you drew and what
the lamp can actually render** side by side, and the way motion reaches the
hardware is by exporting your animation as a real `govee-cli` keyframe effect
that plays through the existing playback engine.

There is a calibration wizard, because the firmware interpolates those 15
segments onto the matrix by an undocumented rule and guessing would be another
confident lie.

## 4. Schedules

The page now shows two distinct things: **Native Rules** (editable) and
**External Automation** (real, read-only, visibly not editable), on a 24-hour
timeline. Your wake-ramp job appears with its ramp band, its weekday/weekend arm
state, and arm/disarm buttons that write the script's own flag file.

Getting the sidecar to read your crontab was the hardest infrastructure problem
of the session. `/usr/bin/crontab` is setgid, and in a systemd **user** unit any
sandboxing directive implicitly enables `NoNewPrivileges`, which strips the
setgid — so `crontab -l` fails with EACCES, and setting `NoNewPrivileges=false`
does not win it back. I did **not** want to trade your sandbox away for one read,
so:

`crontab -l` → the spool file → a snapshot written by a new unsandboxed
`govee-crontab-snapshot.timer`. The UI says which route answered and how stale
it was, because "the crontab says" and "a ten-minute-old copy says" are different
claims. An unreadable crontab is an error state with a message, never "no
schedules".

`wake-ramp` itself gained a `status --json` flag. Plain `wake-ramp status` output
is byte-identical to before — I diffed it — and `run`/`arm`/`disarm` are
untouched. It's backed up at `/tmp/wake-ramp.orig.bak`.

## 5. The look

`.planning/V3_VISUAL_DIRECTION.md` is the full document. The governing idea:
the metaphor moved from "optical bench" (a lab instrument, precise and
apologetic about existing) to a front-of-house lighting rig mid-show.

But "make everything loud" produces mush, so loudness got a budget — the
**Chassis/Signal rule**, four strictly ordered tiers. The light itself is allowed
to be the loudest thing on screen; colour spilling off it onto nearby chassis is
second; the physics of touching a control is third; and the nav, labels and
structure stay silent *precisely so* the first three land. Any proposed change
that can't name its tier doesn't ship.

The load-bearing new idea is that each device's live colour bleeds into its own
card — background, border, ambient shadow — and those bleeds pool across the page
the way separate real fixtures pool on a dark floor. It animates without a React
render per frame.

Readouts went from 10–11px to 20–22px. The tab rail scrolls instead of wrapping
and clipping its own labels. The status chip names the lamp and the scene instead
of saying "1 light active-mode'd".

---

## How this was verified

`scripts/verify_ui.py` drives a headless browser over a mock stack at an iPhone
viewport in both themes, fails on console errors, empty bodies and horizontal
overflow — and **samples the instrument canvas a second apart to assert the
pixels actually changed**, because a motion engine that silently renders one
static frame passes every other check in the project.

Two things it caught about itself, worth knowing:

- Next bakes `rewrites` into the build manifest, so an earlier version of the
  harness was silently driving the **production** sidecar while claiming to be
  isolated. It now builds against its scratch sidecar, into a separate dist dir
  so it can't clobber the deployed build, and **refuses to run unless
  `health.mock` is true.**
- On a clean mock the ledger is empty, so everything is `unknown` and the stage
  correctly renders no motion. The harness now applies a scene through the app's
  own API first — otherwise it was asserting on the wrong state.

Separately, a full `pytest` run had been **writing to your real ledger**: the
live console displayed "Shelf Lamp: music/rolling" for a lamp doing nothing of
the kind. Per-file fixtures couldn't fix a failure of omission, so
`tests/conftest.py` now redirects the ledger for every test whether it knows
about the ledger or not.

**Current state:** 394 Python tests, 74 frontend tests, mypy and ruff clean
across `govee_cli` and `webui`, `npm run typecheck`/`lint`/`build` clean, CI
green, deployed and serving on the tailnet.

---

## Known gaps, honestly

Things I chose not to do, rather than things I missed:

1. **Motion region registration is close, not pixel-exact.** The instruments are
   fixed-pixel elements while the motion regions are normalized fractions, so
   they're proportionally matched rather than measured. It looks right; making it
   exact means measuring the instrument element at runtime and threading bounds
   through, which is a bigger change than the improvement justifies right now.
2. **A playing keyframe effect renders as a generic breathe**, not the literal
   frames. `DeviceState` doesn't carry the effect's keyframes, so wiring the real
   ones needs a prop threaded from the pages into the stage.
3. **The motion canvas paints above the halo, not beneath it.** The spec wants it
   layered inside each per-model instrument; that means touching the halo mount
   points in three components, and the regression risk wasn't worth it in the
   same pass.
4. **`scene <name> --ble` on the H6056 doesn't write the ledger.** The BLE
   built-in-scene path has a different payload shape than the cloud one and I'd
   rather define it deliberately than guess.
5. **Paint studio controls sit under the canvas on mobile, not in a bottom
   sheet.** The Dialog primitive is modal; a persistent non-modal sheet would be
   a new primitive.

## Things you may want to look at

- The `NoNewPrivileges` note in `deploy/govee-webui-api.service` explains why the
  snapshot timer exists. If you'd rather add your user to the `crontab` group,
  the fallback chain will pick up the spool file directly and the timer becomes
  redundant.
- `.verify-ui/` has the screenshots from the last verification run.
- `.planning/WEBUI_V3_SPEC.md` is the full implementation contract (16 tasks,
  disjoint file ownership) if you want to see how it was broken up.

Dogfood it for a day. The thing I'd most want your eyes on is whether the
`assumed` vs `confirmed` distinction on the stage caption actually reads as
useful, or whether it's noise — that's the one design call I couldn't verify
without you.
