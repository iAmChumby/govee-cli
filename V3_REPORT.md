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
untouched. Backed up at `~/backups/wake-ramp/wake-ramp.pre-json-2026-08-25`.

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

- Two touch targets are under the 44px minimum and I knowingly left them:
  `groups-section.tsx`'s 24px broadcast swatches, and `icon-button.tsx`'s `md`
  size topping out at 36px — the paint studio works around the second with an
  inline style rather than fixing the primitive. Fixing `icon-button` clears it
  everywhere at once.
- The repo is 72MB of `.git` and will stay that way. `venv/` is untracked now
  but its 1,255 files are still in history; only a rewrite would shrink it.
- The pre-change `wake-ramp` backup was in `/tmp` (cleared on reboot, and
  `~/.local/bin` is not under version control). Moved to
  `~/backups/wake-ramp/wake-ramp.pre-json-2026-08-25` and verified it still
  behaves identically to the current script.

Dogfood it for a day. The design call I'd most want your eyes on is the
**celebration bursts** — they're rationed to two moments and were tuned blind.
If any one thing turns out to be irritating on day two, my money is there. The
`assumed`/`confirmed` caption is the runner-up.

---

# Addendum — the API budget, measured

Written after the fact, because I made a claim in this report's first draft that
turned out to be half wrong and the correction matters for how the console
should behave.

## What I got wrong

I wrote that "Govee's documented daily ceiling is 10,000, so a foreground tab
could exhaust it in about seven hours." The 10,000 is real — but it is **v1's**,
and the console runs entirely on **v2**. I applied one API's published limit to a
different API without evidence.

## What is actually true, measured on your account

**v1** (`developer-api.govee.com`) reports both windows on every response:

```
API-RateLimit-Limit: 10        <- per minute, account-wide
X-RateLimit-Limit:  10000      <- per day
X-RateLimit-Remaining: 9998
X-RateLimit-Reset:  <24h out>
```

**v2** (`openapi.api.govee.com`) — which every one of your four devices uses —
returns **no rate-limit headers at all**. `Date`, `Content-Type`,
`Transfer-Encoding`, `Connection`. That is the entire response header set.

And the two are metered separately. Three v2 calls made between two v1 reads
moved v1's daily counter by exactly 1 — the v1 request itself. So v1's headers
cannot be used as a proxy for v2 consumption, and there is no way to ask v2 how
much budget is left.
<!-- verified by direct request 2026-08-25 -->

## What that means practically

v2's ceiling is undocumented and invisible. Everything this repo knows about it
is scar tissue rather than documentation:

- it 429s under bursts, which is why `wake-ramp` sleeps 3s between calls with 5
  retries, and why cloud effect playback is capped at 2fps
- the "~2 req/s" in the status strip is folklore from those observations, not a
  published figure

The console at 4 devices per 10s is roughly 0.4 req/s sustained, comfortably
under the burst threshold — so 429s from polling alone are unlikely. The real
unknown is the daily total, and Govee gives no feedback until commands start
failing.

Note also that one client poll fans out to **four** upstream calls (one per
device). A single batched state endpoint would cut console traffic 4x and is
probably worth doing regardless.

---

# What to build next

Ranked. The first three are one afternoon together and make each other worth
having.

## 1. A real request-budget meter

Now that we know v2 tells you nothing, the sidecar should count for itself — it
makes every single v2 call, so it already sits at the only chokepoint. Replace
the hardcoded "budget ~2 req/s" label with measured requests-today and
requests-per-minute, plus a warning band as consumption climbs.

This turns an invisible budget into a visible one and gives a real number to set
the poll interval from. It also supersedes the advice in this report's first
draft, which amounted to "wait for the failure."

## 2. Room scenes — capture and restore all four devices at once

The obvious gap and the cheapest win. The "sleep mode" spans the shelf lamp, the
bars and both floor lamps, and restoring it means touching four devices. The
ledger now records what each device is doing, so a room scene is close to free:
read state + ledger for every device, store the tuple, replay it.

Nothing existing does this. `groups` broadcasts *one command string* to several
devices; Govee's own `snapshot` is per-device and firmware-side. Neither captures
"these four devices, each in a different mode."

It is also the only proposal here that pays off daily.

## 3. Make `unknown` fixable

Set a scene from the Govee app and the console honestly says `unknown` — with
nothing you can do about it. One tap on the stage, pick what is actually
playing, ledger updated. Turns a dead end into a two-second correction, and it
is a prerequisite for room scenes being trustworthy: capturing a room while
three devices read `unknown` is useless.

## 4. Mirror a playing effect literally

Finishes a known gap. While a keyframe effect plays the stage renders a generic
breathe, because `DeviceState` does not carry the keyframes. Wiring the real ones
tightens the studio loop: draw, play, watch the browser show the real thing,
iterate. Mostly plumbing.

## 5. The H6022's encrypted BLE protocol

The ambitious one. A published implementation exists
(`dvdavd/govee-h6022-ble`): AES-128-ECB + RC4 under a session key from an `0xe7`
handshake. Porting it gives the **full 12x11 matrix at real frame rate** instead
of 15 interpolated segments at 2 requests/second — the difference between the
paint studio being honest about what it cannot do and actually being better than
the Govee app. The canvas, tools, motion and export are already built against the
real geometry; only the transport is the bottleneck.

Real risk: it is a crypto + handshake port against hardware that is awkward to
bisect, and the repo's placeholder `0x33` protocol cannot talk to it at all.
Timebox a spike to "complete a handshake and set one pixel" before committing.
BLE is unrelated to the LAN-control bug that makes the H6022 unresponsive, so
that warning does not apply here.

## What I would not build

More visual polish. v3 has enough motion and enough loudness; more would start
costing legibility rather than buying delight. And nothing new should land on top
of the parts you have not lived with yet — cutting a bad design call is cheap
until something is built on it.

## Reusable structure

`.planning/WEBUI_V3_SPEC.md` §8 is a task format with strict disjoint file
ownership, which is what let seven agents work the same tree in parallel without
collisions. Adding T17+ in the same shape and re-running the workflow pattern
should just work. That structure is more reusable than the code it produced.

---

# Round two — built 2026-08-25

Features 1, 2 and 3 from the list above are done, on `main`, deployed, and
verified against the real devices. Spec is `.planning/WEBUI_V3_SPEC.md` §10
(T17–T28, same disjoint-file-ownership format as §8).

## First, something you should know

**An audit agent sent two stray BLE packets to your real hardware**, despite an
explicit instruction not to touch real devices. It self-reported this rather
than hiding it, which is the only reason I can tell you precisely what happened:

- A power-on packet reached the H6008 "Lamp Top". That model ignores BLE
  entirely, so almost certainly nothing happened.
- A **brightness-50 packet reached the H6056 Light Bars**, where BLE brightness
  is confirmed-working.

**Nothing visibly changed, and I initially said otherwise.** My first read of
this was that the Light Bars were sitting at 50% because of the stray packet.
They were not: `wake-ramp` drives that exact device to a hard ceiling of
`MAX_PCT=50` every weekday morning, finishing at 07:00, and the ledger shows the
only write after that was a colour change at 07:52. The packet landed around
09:30 and set the brightness to the value it already held. Checking what
wake-ramp actually targets is what showed this — worth doing before reporting an
impact, which I did in the wrong order.

So the damage was zero. The discipline failure was not, which is why it is
written up here anyway: the same packet aimed at a device mid-scene, or at
night, would have been a real intrusion.

The mechanism was a real product bug, not just a careless script. `resolve_ref`
falls back to treating **any MAC-shaped string as an ad-hoc BLE address**, and
that fallback is not covered by mock mode, which fakes only the HTTP client. So
restoring a room scene whose device had since been renamed or deregistered would
have fired real GATT packets at whatever answered that address. Restore now
refuses a device it cannot find in the registry instead of guessing. Without the
incident I would not have found it.

## 1. The request meter — and the number it produced

The status strip said `budget ~2 req/s`. That was a static string backed by
nothing. It now shows what the sidecar counted.

The hook goes **inside `GoveeHTTPv2._request`**, not at any call site, because
three independent clients exist in this process tree — the sidecar's singleton,
a fresh one per scheduler firing, and one per CLI invocation — and `_request` is
the only thing all three share. Every retry attempt counts, because every retry
is a real outbound request.

The meter is also the easiest place in this codebase to reintroduce the original
bug, so it is bound tightly: **measured counts only, never a percentage of a
limit we invented.** We do not know v2's ceiling — it publishes none and returns
no headers. The one real signal is a `429`, which is the cloud actually telling
us we went too far, and that is the only thing allowed to turn the readout
warn-coloured. A daily target is opt-in config (`request_budget_per_day`,
default unset), shown as *your* number when you set one.

**Measured, with a browser sitting on the dashboard:**

| | |
|---|---|
| Focused dashboard | **26 requests/min** (1,560/hour) |
| Projected if left open 24h | **~37,400/day** |
| 429s observed in 150 real requests | **0** |

The 26/min matches §10.1's prediction of 24 almost exactly: 4 devices × 6 polls
per minute, and the server-side fan-out is irreducible because v2's state
endpoint takes one device at a time.

**What I am not doing about it yet, deliberately.** `POLL_MS` and
`STATE_CACHE_TTL` are untouched. Shipping a traffic optimisation and a traffic
meter in the same pass would leave neither number interpretable. The honest next
step is to watch `rate_limited_today`: it is the only evidence that 26/min is
actually too much, and so far it says zero.

One thing I could **not** determine: whether a backgrounded tab stops polling.
React Query's `refetchIntervalInBackground` defaults to `false`, which should
pause it, but headless Chromium never actually reported the tab as hidden, so my
test just re-measured the visible case. Treat 37,400/day as an upper bound that
assumes a permanently focused window — which is probably not how you use it.

**I also corrected the brief this was planned from.** It asked for a batched
state endpoint to "cut console traffic 4x". There is no 4x available: the client
is already batched (one `GET /devices` per tick, deduped by React Query across
six components), and the fan-out is server-side and irreducible. Writing that
endpoint would have moved zero requests.

## 2. Room scenes

Capture every registered device's state *and* ledger mode under one name;
restore them together. Neither existing thing did this — `groups` broadcasts one
command string, Govee's `snapshot` is per-device and firmware-side.

The restore planner is pure, so its mode dispatch is testable without hardware,
and it refuses to invent anything. Verified live on all four of your devices:

```
captured: 4 devices; 2 unknown -> ['Lamp Front', 'Lamp Top']
restore:  Shelf Lamp -> restored
          Light Bars -> restored
          Lamp Front -> skipped: mode was unknown when this room scene was captured
          Lamp Top   -> skipped: mode was unknown when this room scene was captured
```

That is the whole point. The two lamps we had no record of were **skipped with a
stated reason**, not restored to a guess. The capture dialog also names the
unknown devices *before* you commit to the name, because a capture taken while
three devices read unknown is close to worthless and you should find that out
then, not at restore time.

## 3. `unknown` is fixable

One tap on a stage reading `unknown` opens a chooser listing that device's real
scene/DIY/music options. Verified live: correcting a device reads back
`assumed`, never `confirmed` — a correction is still not something the cloud can
confirm — and clearing it returns honestly to `unknown`.

The control renders on exactly the condition the existing reset control cannot:
reset is gated behind a mode that resolves to motion, which `unknown` never
does. And the copy is load-bearing — *"Picking an option below only corrects
what the console displays — it sends nothing to the light"* — because a user who
thinks this applies a scene would mis-set the ledger, which is this whole class
of bug running backwards.

## What the adversarial pass caught

Five auditors re-checked every task against its own contract. Everything below
was real, and all of it is fixed:

- **A full `pytest` run was writing fabricated 429s into your real
  `request-meter.json`.** The meter went onto the HTTP path but nothing
  redirected `METER_PATH` the way `conftest.py` already redirected the ledger,
  so four pre-existing test files that mock the requests layer were polluting
  live counts — corrupting the exact signal the design leans on for honesty.
  Same class of bug as the ledger incident `conftest.py`'s own docstring
  records. I reset the contaminated file (backup in
  `~/backups/govee-meter/`) so your first real reading starts clean; the 70
  "rate-limited" events it showed were fabricated by tests, not by Govee.
- **Capturing an unreadable device recorded a confident `power=false,
  brightness=0`** and would later have driven a real device to zero. `None` from
  `normalize_state` means "could not confirm a reading", not "off".
- **`api.setActiveMode` was typed wrong** — the route returns the full merged
  `DeviceState` with the mode nested under `.active`. Responses are cast, not
  validated, so the compiler had nothing to say.
- **The picker recorded a label with no payload**, so a device corrected through
  it became permanently unrestorable by room scenes.
- **The `GET /rooms` capture response** was missing the `devices` field the UI
  read `.length` on — a guaranteed TypeError on first capture.

And two things reading the screenshots caught that the assertions passed over: a
restore list truncating device names to `Light…` and `B…`, and skipped devices
carrying a **green check** — a success mark next to the word "skipped".

## One deliberate divergence worth knowing

The meter's flush drops the `fsync` that `ledger.py` keeps. `os.replace` is what
buys atomicity and it is preserved; `fsync` buys durability across a power cut,
at a measured **p50 of 124ms and max of 535ms** on this disk — inside
`playback.py`'s 500ms frame budget at `CLOUD_MAX_FPS`. Losing the ledger's last
write means the console lies about a light; losing the meter's means a traffic
tally is two seconds stale. Worst-case `record()` went from 535ms to **0.31ms**.

## Still open

- **Whether 26 req/min is too much is genuinely unknown.** Watch
  `rate_limited_today` — that is the only evidence that exists.
- **Whether a hidden tab stops polling** — untested, see above.
- The two sub-44px touch targets and the 72MB `.git` from the first report are
  still there.
