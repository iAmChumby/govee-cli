# V3 Visual Direction — replacement for WEBUI_V3_SPEC.md §7

This document replaces §7 ("Visual direction") of `WEBUI_V3_SPEC.md` wholesale. The
existing §7 concluded "the optical-bench language stays; nothing introduces a new
token." That conclusion is wrong for this project. Luke, verbatim, on what this app is
for:

> "This UI was kind of designed with the over-the-top mentality in mind. It's meant to
> be flashy and look good and have a lot of motion and everything. So if a UI choice
> seems like it would be distracting or something like that or take up attention or
> draw the user to it, that's actually probably the thing you wanna go for. Elements
> should be kind of distinct. They should be fun to interact with. They should be cool
> to kind of manage your lights even though it is kind of a menial task."

The current build (v2, screenshots: `images/IMG_1019.PNG`, `IMG_1020.PNG`,
`IMG_1025.PNG`) is a monitoring dashboard for a server rack: flat charcoal cards, a
tiny instrument stranded in acres of dead space, a generic slider-plus-swatch-row
under it, everything the same neutral gray whether the light is off or blazing violet.
That reads as *restrained*, not *controlled*. This document throws it out and replaces
it with a system where the console itself looks like it's plugged into the same power
as the lights it drives.

Everything below cashes out in a real token, property, component prop, spring
constant, or pixel number. Nowhere does it say "modern" or "sleek."

---

## A. The governing metaphor

**This is a front-of-house lighting rig, live, in a dark room, mid-show — not an
optical bench.** An optical bench is a science-lab instrument: precise, inert,
apologetic about its own existence. A FOH rig is a physical control surface built to
be looked at *and* touched in the dark by someone who needs to feel where their hand
is without looking down — backlit faders, RGB indicator rings, channel strips that
glow with the actual color of the signal running through them, big analog-style
readouts you can read from across a dark room. The chassis (the housing, the metal,
the labels silkscreened on it) is deliberately inert and matte so it disappears; the
*signal* (the light itself, and everything reporting on the light) is what the rig
exists to make loud. Every decision below follows from that split: the console is a
piece of hardware built around the light, not a spreadsheet that happens to display a
light's status. "filament" — the app's own wordmark, already carrying an incandescent
warm-up animation — already wants this; v2 just never let it happen anywhere but the
stage instrument itself.

---

## B. The loudness budget — the Chassis/Signal rule

"Make everything loud" produces mush, and the current build's failure mode in reverse
(muting everything to be safe) is just as real a failure. The fix is a named,
explicit hierarchy, applied identically everywhere in this document.

**The Chassis/Signal rule:** every pixel on screen is either **chassis** (the rig's
own housing — it never emits, never carries device color, never animates on its own)
or **signal** (something reporting live device state — it is *allowed* to be the
loudest thing in its neighborhood, and the closer it is to the physical light, the
louder it's allowed to get). Four tiers, strictly ordered:

1. **SIGNAL-PRIME** — the device's actual live emission: `DeviceStage`/`MotionCanvas`
   core, halo, and (new) particle bursts. Full saturation, the real device hue,
   uncapped opacity within the instrument's own bounds. This is the only tier allowed
   to be the single most saturated color on the screen. Nothing else may exceed it.
2. **SIGNAL-SPILL** — color *derived* from SIGNAL-PRIME bleeding onto surrounding
   chassis: card backgrounds, card borders, ambient shadows, control tints, toast
   accent bars. Same hue as tier 1, but opacity/saturation dramatically cut (§C gives
   real numbers) so it reads as light spilling off the fixture, never competes with
   the fixture itself. Also home to the two celebration bursts (§E) — loud but
   deliberately brief.
3. **CONTROL-RESPONSE** — the momentary physics of touching something: press-in
   scale, drag feedback, spring-back. Loud for ~100–300ms, then gone. No ambient
   looping motion beyond what already exists (`Breath`, the wordmark's `dot-breathe`).
4. **CHASSIS** — top bar, nav rail, status strip, section labels, hairlines, panel
   borders in their idle state, body copy, page background. Zero color beyond the
   existing neutral token set, zero animation beyond the two pre-existing ambient
   loops. This tier's silence is what makes tiers 1–3 land — detailed in §G.

Every component in §D is graded against this rule. If a proposed change can't name
its tier, it doesn't ship.

---

## C. Color and light spill

The single best lever available: **the live color of each device bleeds into its own
card — background, border, ambient shadow — and that bleed composes across the page
by literally overlapping, the way light from separate real fixtures pools on a dark
floor.** No new npm dependency; this is `@property`-registered CSS custom properties
plus `color-mix()`, both already load-bearing in this codebase (`tokens.css` already
registers `--glow-alpha`/`--glow-scale`/`--glow-hue`/`--glow-radius`).

### New tokens

`tokens.css` currently registers `--glow-hue`, `--glow-scale`, and `--glow-radius` via
`@property` but **nothing in the codebase reads them** (confirmed by grep — only
`--glow-alpha` has consumers, in `Halo` and `Switch`). They're dead weight. Repurpose
`--glow-radius` as the shared ambient-shadow blur channel (identical meaning either
way: "how far this glow reaches"); leave `--glow-hue`/`--glow-scale` alone so a future
per-instrument use doesn't collide with the new card-level system. Add four new
registered properties, distinctly named `--dev-*` so "this describes the DOM
subtree's live device state" is never confused with `--glow-*` ("this instrument's
own internal emission," `Halo`'s job, unchanged):

```css
/* tokens.css — new, alongside the existing @property block */
@property --dev-hue {
  syntax: "<number>";
  inherits: true;
  initial-value: 36; /* WARM_HSL's hue — matches the off/unknown fallback */
}
@property --dev-sat {
  syntax: "<percentage>";
  inherits: true;
  initial-value: 0%;
}
@property --dev-light {
  syntax: "<percentage>";
  inherits: true;
  initial-value: 50%;
}
@property --dev-alpha {
  syntax: "<number>";
  inherits: true;
  initial-value: 0; /* off/unknown = zero bleed, always */
}
```

`inherits: true` is deliberate: each card sets its own `--dev-*` quartet on its own
root element, and every descendant (`Slider` thumb, `Switch` track, quick-swatch
buttons) reads `var(--dev-hue)` and resolves to *its own card's* value — nearest
definition wins in the cascade. That's how four devices with four colors compose on
one page without any component needing to know about its siblings.

### How it updates without re-rendering React on every frame

Two different update rates, two different mechanisms — the reason this doesn't cost a
per-frame JS loop:

- **Hue/saturation/lightness** change only when device *state* changes (a poll tick or
  an optimistic write lands in the query cache) — not every animation frame. A new
  hook, `useDeviceBleed(ref, hsl, power, brightness)` (`lib/device-bleed.ts`, new),
  writes the three values as an inline `style` object from the already-rerendering
  `DevicePlate`/card component — this is not new render cost, the component already
  re-renders on that same state change today. All the *smoothing* between an old hue
  and a new one is delegated to a plain CSS `transition` on `--dev-hue`/`--dev-sat`/
  `--dev-light` (legal and animatable specifically because they're `@property`
  registered) — zero JS ticking involved.
- **Alpha** (the overall bleed intensity — 0 when off, brightness-scaled when on)
  needs the same continuous, physically-weighted feel as the rest of the instrument's
  glow, so it rides a `motion/react` spring exactly like `useGlow` already does for
  the instrument's own emission — but it's written to the DOM **imperatively** via
  `useMotionValueEvent` calling `cardEl.style.setProperty("--dev-alpha", v)` on a ref,
  never through React state. This is the identical pattern `Halo` already uses for
  `--glow-alpha`; `device-bleed.ts` just applies it one level up, at the card root.

Net effect: no second per-frame JS loop is added anywhere in the chrome layer, which
satisfies the hard 60fps constraint — the motion engine's Canvas2D ticker (§4 of the
spec) remains the only thing driving a `requestAnimationFrame` loop.

### The bleed itself (card-level)

```css
/* globals.css — new, additive, opt-in via a Panel prop (see §D) */
.dev-bleed {
  background-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 14%),
    var(--panel)
  );
  border-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 55%),
    var(--hairline)
  );
  box-shadow: 0 0 var(--glow-radius) -60px
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light) / calc(var(--dev-alpha) * 0.55));
  transition:
    background-color var(--dur-slow) var(--ease-out-soft),
    border-color var(--dur-slow) var(--ease-out-soft),
    box-shadow var(--dur-slow) var(--ease-out-soft),
    --dev-hue var(--dur-slow) var(--ease-out-soft),
    --dev-alpha var(--dur-base) var(--ease-out-soft);
}

:root[data-theme="light"] .dev-bleed,
:root:not(.dark) .dev-bleed {
  /* light theme starts near-white; the same mix ratio reads as a much stronger
     tint against a bright background, so it's cut further here. */
  background-color: color-mix(
    in oklch,
    hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)) calc(var(--dev-alpha) * 8%),
    var(--panel)
  );
}
```

`14%` (dark) / `8%` (light) on the background mix and `55%` on the border are chosen
to keep `--text-hi`/`--text-mid` at ≥4.5:1 against the tinted background even at full
`--dev-alpha` and a saturated device hue — this is a claim, not a fact, and T16's
verify step (§H) requires actually checking it with a contrast tool against the worst
case (a fully-saturated, high-lightness device color like Govee's near-white
`#EAF2FF` swatch), not just asserting the math looks safe.

**Degrading when off:** `power === false` or `online === false` springs `--dev-alpha`
to `0` on `springStandard` (matching `useGlow`'s existing on/off physics) while
`--dev-hue`/`--dev-sat`/`--dev-light` simply hold their last value — the card fades to
flat chassis rather than snapping, and never flashes toward some default hue on the
way down. An off card is required by §B/§G to be the calmest thing on the page; this
is how that's enforced at the token level, not just by convention.

**Composing four different colors on one page:** deliberately **not** a single
averaged "scene color." Averaging red and blue into a muddy purple that matches
neither device would be dishonest and would need new aggregation logic besides.
Instead, each card's own `box-shadow` blur (`--glow-radius`, tuned per breakpoint,
default ~120px on mobile cards) spills a few dozen pixels past its own edges into the
shared `--bg` canvas — so with four differently-colored cards visible in the grid, the
page background genuinely shows four distinct pools of colored light where the cards'
shadows overlap the gaps between them, exactly like real fixtures in a dark room. This
satisfies "the page background itself" from the brief with zero new JS and zero
averaging math — it's a direct, honest consequence of the per-card token already
existing.

---

## D. Component-by-component before/after

Every entry below is tagged with its Chassis/Signal tier from §B.

### Device card (dashboard) — SIGNAL-SPILL for surface, SIGNAL-PRIME for the instrument

**Today:** `Panel` with `p-4`, flat `bg-panel`, hairline border, never changes color;
the live instrument (`DeviceStage variant="mini"`) is pinned at a fixed `h-28`
(112px) regardless of device geometry, stranded above a slider, a mono readout row,
and a wrapped row of six generic swatch buttons — see `IMG_1019.PNG`: the actual light
render occupies maybe 15% of the card's vertical space.

**Becomes:** the `.dev-bleed` treatment from §C on the card root (a new `bleed` prop
on `Panel`, default `false` so every other `Panel` consumer — paint studio, dialogs,
settings — is unaffected); the instrument container sized by `aspect-ratio` instead of
a fixed height so each geometry (bars/matrix/orb) gets proportional space instead of
being squeezed into one generic box; the quick-swatch + temp-preset row collapses into
a single horizontal-scroll "channel strip" dock at the card's bottom edge instead of
wrapping across two rows of dead space.

```tsx
// components/device/device-plate.tsx (new, extracted from page.tsx)
<Panel bleed className="p-4">
  <CardHeader … />
  <Link href={…} className="mt-3 block aspect-[4/3] overflow-hidden rounded-card sm:aspect-[16/10]">
    <DeviceStage state={device} variant="mini" className="h-full" />
  </Link>
  <BrightnessRow … />          {/* slider, tinted per §D "Brightness slider" */}
  <ChannelStripDock … />        {/* horizontal-scroll swatches + temp presets */}
</Panel>
```

```css
/* the dock: one row, scrolls instead of wraps — recovers the vertical space
   the old two-row wrap was spending on padding between rows */
.channel-strip-dock {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-block: 10px;
  border-top: 1px solid var(--hairline);
  mask-image: linear-gradient(to right, transparent, black 12px, black calc(100% - 20px), transparent);
}
```

### Brightness slider — CONTROL-RESPONSE, thumb is SIGNAL-SPILL while dragging

**Today (`ui/slider.tsx`):** neutral `bg-accent` fill and thumb, identical for every
device regardless of color — a red lamp and a white lamp get an identical white
progress bar.

**Becomes:** the fill and thumb inherit `var(--dev-hue)`/`var(--dev-sat)` while
dragging (a real dimmer fader tinted by the channel it drives), reverting to the
neutral `--accent` fill when idle so the *track itself* stays chassis-quiet and only
the *live drag* is loud (this is the Chassis/Signal split applied inside a single
component, not just between components):

```tsx
// slider.tsx — additive `tint?: boolean` prop, default false (no regression)
<motion.div
  className="absolute left-0 h-full rounded-full"
  style={{
    width: fillWidthStyle,
    backgroundColor: tint && dragging
      ? "hsl(var(--dev-hue) var(--dev-sat) var(--dev-light))"
      : "var(--accent)",
  }}
/>
```
```css
/* thumb glow while dragging, tint-aware, compositor-only (opacity/transform) */
.slider-thumb[data-dragging="true"][data-tint="true"] {
  box-shadow: 0 0 0 8px hsl(var(--dev-hue) var(--dev-sat) var(--dev-light) / 0.22);
  transition: box-shadow var(--dur-fast) var(--ease-out-soft);
}
```

### Power switch — CONTROL-RESPONSE + a SIGNAL-SPILL flourish on the "on" flip

**Today (`ui/switch.tsx`):** already the best-built primitive in the system — the
`--glow-alpha`-driven fill and the `pending` breathing halo are exactly the right
idea, just monochrome. Keep the mechanism, add color.

**Becomes:** the "on" fill gradient becomes `hsl(var(--dev-hue) …)` instead of the
neutral `from-accent to-accent-press`, and the flip itself gets one `springCelebrate`
overshoot (§E) instead of `springStandard` — a switch that visibly "kicks" on, the way
a real illuminated rocker switch does, then settles:

```tsx
// switch.tsx — additive `hue?: boolean` prop
<motion.span
  className="absolute inset-0 rounded-full [opacity:var(--glow-alpha)]"
  style={{
    background: hue
      ? "linear-gradient(135deg, hsl(var(--dev-hue) var(--dev-sat) var(--dev-light)), hsl(var(--dev-hue) var(--dev-sat) calc(var(--dev-light) - 14%)))"
      : undefined,
  }}
/>
```
The default (`hue` omitted) renders byte-identical to today — every non-device switch
(settings toggles, future generic uses) stays neutral chassis automatically.

### Top bar — CHASSIS, unchanged in kind, tightened in weight

**Today:** flat `bg-bg`, hairline bottom border, wordmark with its existing
`dot-breathe` loop. Correct already — stays chassis per §G. The one change: the
`ThemeToggle`/nav icon buttons pick up `springSnappy` (§E) on press instead of no
explicit press physics, so the one interactive chrome in the bar still feels alive
without the bar itself gaining any color.

### Status strip — CHASSIS, with one SIGNAL-SPILL accent

**Today:** flat mono footer, `StatusDot` for sidecar health. Stays flat. The one
addition: when the active-mode ledger (spec §3) reports any device in a non-`basic`
mode, a single small `Chip` — "3 lights active-modeʼd" or similar, tone `accent` —
appears at the strip's far end, using the *aggregate* palette-drift color from
whichever device the user most recently touched, not a running average (same honesty
rule as §C). Purely informational; no motion.

### Color swatches / picker — SIGNAL-PRIME candidates, currently the *only* place
color already lives correctly

**Today:** `SwatchRow`'s 10 curated colors are exactly right — real, saturated,
content-is-color per the old spec's own rule. Keep verbatim. **Change:** the active
swatch's ring (`ring-2 ring-accent`) becomes `ring-[3px]` in the swatch's *own* color
via `color-mix()` rather than the neutral accent ring, so picking a color visibly
"claims" that swatch instead of wrapping it in a generic white outline — a small
change, but it's the difference between "this button is selected" (chassis language)
and "this is the color the lamp is now making" (signal language).

### Tabs — CHASSIS, unchanged

The spring-underline mechanism (`layoutId`-shared indicator) already does exactly what
a rig's channel-select LED strip does — reuses `springStandard`, no color, no change.
Explicitly named here as a component that **passes** the audit without modification;
see §G.

### Buttons — CHASSIS by default, SIGNAL-SPILL for the one "apply paint" / "confirm"
class of action

**Today:** three flat variants (`solid`/`ghost`/`danger`), `whileTap` scale to 0.97 on
`springStandard`. **Becomes:** press physics upgrade to `springSnappy` uniformly (a
button should feel like it has more resistance than a slider drag); a fourth variant,
`variant="signal"`, exists only for buttons that commit a device-affecting action from
inside an already-colored context (paint studio's "apply," the stage's floating
"paint N segments" button) — it inherits `var(--dev-hue)` as its fill instead of
`--accent`. Every other button (nav, settings, dialogs) stays the existing neutral
variants — chassis by default, signal only where it's committing color to a device.

### Section labels — CHASSIS, explicitly frozen

`"01 — POWER"` stays exactly as sized/colored today (10–11px, `--text-low`/`--text-mid`,
`tracking-micro`). Named in §F/§G as one of the things that must **not** get louder —
it's furniture, and furniture getting loud is how you get mush.

### Toasts — SIGNAL-SPILL, and the site of celebration moment #2

**Today:** left-edge 3px bar colored by variant (`sage`/`ember`/`accent`), otherwise
neutral panel. **Becomes:** when a toast reports a *device* action (not a system
message), the bar becomes `hsl(var(--dev-hue) …)` instead of the fixed variant color,
and on mount it does one `springCelebrate` brightness pulse (see §E, "scene
confirmed") before settling to steady — the toast literally flares once to say "this
landed," then goes quiet, which is the loud/quiet dynamic from §B applied to a single
component's own lifecycle.

### Dialogs — CHASSIS shell, SIGNAL-SPILL only if launched from a colored context

`Dialog`'s `springHeavy` entrance and flat `--raised` surface stay as-is (this is
correct restraint — a modal asking "are you sure" should never be trying to compete
for attention with the thing it's confirming). The one exception: the calibration
wizard and export dialog (owned by T13, not this document's tasks) may reasonably
inherit the originating device's `--dev-hue` on their header accent only, matching the
"signal follows the device, chassis stays neutral" split — noted here for consistency,
not something T15/T16 implement since those files belong to T13.

### Schedules timeline — CHASSIS with SIGNAL-SPILL wake bands (T14's territory, noted
for consistency only — not implemented by T15/T16)

Per spec §7's original note, the wake-ramp duration band should use `--accent-dim`
when armed. Recommend upgrading that to the target device's `--dev-hue` at low alpha
instead — a wake-ramp that's about to turn the bedroom lamp warm-white should visually
hint at *that* color, not a generic accent tint. This is a one-line change inside
T14's existing scope; flagged here so the two documents don't disagree, not claimed by
T15/T16's file lists.

---

## E. Interaction and feel

**Springs.** Keep all three existing (`springStandard` 260/26 for routine settle,
`springHeavy` 170/22 for panel/dialog entrances, `fadeFast` 150ms for exits) exactly
as-is — they're correct for what they already do. Add two, in `lib/motion.ts`:

```ts
/** Press-in physics: buttons, switch thumb, slider thumb, dial knob on touch-down.
    Crisper than springStandard — a press should feel like it has more resistance
    than a value settling. */
export const springSnappy: Transition = { type: "spring", stiffness: 500, damping: 30 };

/** The two celebration moments only (§E) — visibly overshoots once before settling,
    like a VU needle kicking. Never used for routine state changes. */
export const springCelebrate: Transition = { type: "spring", stiffness: 260, damping: 12 };
```

**Press/release physics.** Every primitive's `whileTap` moves from `springStandard` to
`springSnappy` — press-down should feel immediate and slightly resistant; release
still eases out on `springStandard` so it doesn't feel twitchy. Guard: wrap the scale
transform in a `useReducedMotion()` check (currently `Button`'s `whileTap` doesn't
check this at all — a gap this document flags for T15 to close) so reduced-motion
users get an instant state change with no scale.

**Sent vs. confirmed.** The intent ledger already gives every mutating control a
12s-hold optimistic state (spec §3/§4.3) and `Switch`'s `pending` prop already shows a
breathing ring while unconfirmed. Extend that ring treatment to the slider thumb and
dial knob (currently only `Switch` has it). The **moment of confirmation** — the
polled state catching up to the optimistic one — gets a distinct, brief `springCelebrate`
pulse: the control's `--dev-alpha`-driven glow spikes to 1.3× peak for ~180ms then
settles to its steady value. This is the "the cloud caught up" tell that v2 has no
equivalent of at all — right now a confirmed command is silently indistinguishable
from an unconfirmed one once the ring stops breathing.

**Drag on the slider.** Already covered in §D — thumb and fill tint to the device
color only while actively dragging, reverting to neutral chassis when released and
idle (so a settled brightness slider doesn't sit there glowing all the time — that
would violate §B's "quiet when not actively signaling" tier discipline).

**Route transitions, dashboard ↔ device console.** This codebase already uses the
View Transitions API for the theme toggle (`globals.css`'s `::view-transition-old/new`
rules). Reuse the exact same mechanism for "opening" a device: give the mini stage on
the dashboard card and the hero stage on the console page the same
`view-transition-name: stage-${ref}` (set via inline style, only while the transition
is in flight), and wrap the `Link`'s navigation in `document.startViewTransition()`
when the API is available and `!prefersReducedMotion`. The card's instrument visually
*grows* into the console's hero instrument — no shared React tree needed, no new
dependency, and it degrades automatically to a plain instant navigation when the API
or the user's motion preference says no.

**List entrance stagger.** `staggerParent`/`panelIn` stay as-is (0.07s stagger, spring
settle) — this already reads correctly as "the board powering up" *because* `useWarmth`
already replays the filament ignite on mount for any device that's on. No change
needed; noted here so it isn't accidentally "fixed" by a future pass that doesn't
realize it's already doing the right thing.

**Celebration moment #1 — "first light."** When a device flips off→on (not on
mount, not on brightness change — specifically the off→on power transition), fire a
one-shot particle burst on the `DeviceStage`'s own Canvas2D layer: 6–10 small bright
sparks radiating from the instrument's core, `globalCompositeOperation: "screen"`,
decaying over ~400ms. This is a single imperative draw call sequence, not a persistent
loop — it does not add a second `requestAnimationFrame` subscriber to the motion
engine's driver (spec §4.1's budget stays intact); it's scheduled via one `setTimeout`-
stepped sequence or piggybacks the existing driver's tick for its ~400ms lifetime and
unsubscribes itself. Reduced motion: skip the burst, do one instant brightness flash
on the core instead (a single opacity keyframe already legal under the global
transition-duration override).

**Celebration moment #2 — "scene confirmed."** Covered under Toasts (§D) and "sent
vs. confirmed" above — when a scene/DIY/effect application's ledger entry flips from
`assumed`→`confirmed` (or an optimistic apply resolves), the toast reporting it uses
the device's hue for its bar and does the `springCelebrate` flare; if the originating
device's card is visible on the same page, it gets a single matching ring-pulse around
its `.dev-bleed` border so a dashboard-initiated action visibly "arrives" back where
it was sent from. Reduced motion: the toast bar still recolors (a color property, not
motion) but skips the pulse animation; the card border does one instant color-mix step
instead of a ringed pulse.

---

## F. Typography and layout

**What survives:** the mono-micro-label system (`SectionLabel`'s `"01 — TITLE"`
pattern, uppercase, `tracking-micro`, `--text-low`/`--text-mid`) is correct chassis
furniture and stays exactly the size it is today — 10–11px. It is explicitly *not*
part of what gets louder (§G).

**What gets bigger:** the thing that changes is what the labels are *labeling*. Every
live readout — brightness %, Kelvin, hex — currently renders at 10–11px `font-mono`,
the same visual weight as the caption next to it. That's backwards: the number that
says what the light is doing *right now* should read like an instrument-cluster
digit, not a footnote.

**Type scale:**

| Role | Today | Becomes | Notes |
|---|---|---|---|
| Console/device page title | 18–20px (`text-lg`/`text-xl`), weight 500–600 | 26–28px, weight 600, `tracking-[-0.02em]` | Archivo, unchanged family |
| Card device name (plate) | 13px medium | 15px medium | small bump, still scannable at arm's length |
| **Live readout digits** (brightness %, Kelvin, hex swatch label) | 10–11px `font-mono` | **20–22px `font-mono`, `tabular-nums`** | the single biggest change — `Odometer` gains a `size="lg"` prop, default unchanged |
| Section micro-labels | 10–11px uppercase, `tracking-micro` | **unchanged** | frozen per §G |
| Body/paragraph | 13px | unchanged | |
| Chips/mono tags | 10px | unchanged | |

**Mobile layout.** The screenshots show a plain vertical stack of cards where the live
instrument is a small garnish above a stack of generic controls (`IMG_1019.PNG`:
roughly 15% of card height is the actual light render). The fix isn't a new layout
paradigm (still a single-column stack on phone — that's the right call for one-handed
use at night) — it's giving the instrument the space it should already have:

- Instrument container sized by `aspect-ratio` (4:3 default, 16:10 on ≥`sm`) instead
  of the current fixed `h-28` (112px) — each geometry (orb/bars/matrix) gets
  proportional space instead of all three being crushed into one generic box.
- The quick-swatch + temp-preset controls move from a two-row wrap into the single
  horizontal-scroll "channel strip" dock described in §D — recovers the vertical space
  the old wrap was spending on inter-row padding and puts it back into the instrument.
- Card header (`StatusDot` + name + model chip + switch) tightens its vertical padding
  slightly — it's chassis, it doesn't need the breathing room the instrument does.
- Grid stays single-column on mobile (`sm:grid-cols-2` already correct for tablet/
  desktop) — no carousel, no swipe paradigm change; the win is entirely "each card is
  now mostly light, not mostly gray."

---

## G. What must NOT change, and why

A visual direction that says "everything gets louder" is a failed one — this section
is the honest accounting of what stays exactly as restrained as it is today, because
that restraint is the only thing that lets §B's tiers 1–3 read as loud *by contrast*.

- **Chassis stays chassis, unconditionally.** Top bar, nav rail, status strip, section
  labels, hairlines, panel borders in their idle (non-`dev-bleed`) state, body copy,
  page background — zero new color tokens applied to any of these, zero new looping
  animation beyond the two that already exist (wordmark `dot-breathe`, idle `Breath`).
  If a future task is tempted to tint the top bar because "it would look cool," that's
  the rule this section exists to block.
- **Section micro-labels are frozen at their current size and weight.** They are
  furniture. The moment "01 — POWER" competes visually with the number it's labeling,
  the reader loses the thing that told them where to look first.
- **Celebration is rationed to exactly two named moments** (§E), not a general
  "everything pulses on interaction" policy. A burst that fires on every routine
  brightness drag stops being a celebration within about three uses — it's just
  noise, and it's the fastest way to make the loud tier stop meaning anything.
  Celebrations are reserved for state *transitions* (off→on, unconfirmed→confirmed),
  never for continuous/repeated interaction.
- **The motion budget is not renegotiated.** One shared `requestAnimationFrame`
  ticker for the whole app (spec §4.1) remains the only per-frame JS loop; every
  chrome effect in this document — card bleed, thumb tint, switch fill, toast
  flare — is either a plain CSS `transition` on an `@property`-registered custom
  property or a `motion/react` spring driven by discrete state changes, never a
  second per-frame subscriber. This is why §C spent as long as it did justifying the
  update mechanism instead of just saying "add a glow."
- **Off is the calmest state on the page, always.** `--dev-alpha: 0` is not a style
  choice, it's the thing that makes "on" mean something. An off device's card must be
  indistinguishable from a plain `Panel` with no `bleed` — no residual tint, no
  ghosting, no "still kind of glowing" compromise.
- **Contrast is verified, not assumed.** Every bleed-mix percentage in §C is a
  starting number, explicitly called out as needing a real contrast check against the
  worst-case device color (§H's verify steps), not a value trusted because the math
  looks conservative on paper.

---

## H. Implementation tasks

Formatted to match §8's existing task entries. Neither task owns a file already
claimed by T01–T14 — cross-checked against every file list in §8. T15 is the
design-system layer (tokens, primitives, motion constants); T16 consumes it to
rebuild the dashboard and shell. T15 has no dependency on the backend ledger work
(T01–T09) — it's a pure frontend-library pass, additive and inert until something
opts in, so it can run in parallel with the entire ledger/motion-engine track. T16
depends only on T15.

---

**T15 — Design system: Chassis/Signal token and primitive layer**
Files: `webui/app/src/styles/tokens.css` (MODIFIED), `webui/app/src/styles/globals.css`
(MODIFIED), `webui/app/src/lib/motion.ts` (MODIFIED), `webui/app/src/lib/device-bleed.ts`
(NEW), `webui/app/src/components/ui/panel.tsx` (MODIFIED), `webui/app/src/components/
ui/button.tsx` (MODIFIED), `webui/app/src/components/ui/slider.tsx` (MODIFIED),
`webui/app/src/components/ui/dial.tsx` (MODIFIED), `webui/app/src/components/ui/
switch.tsx` (MODIFIED), `webui/app/src/components/ui/chip.tsx` (MODIFIED),
`webui/app/src/components/ui/odometer.tsx` (MODIFIED), `webui/app/src/components/ui/
toaster.tsx` (MODIFIED), `webui/app/src/components/ui/section-label.tsx` (MODIFIED),
`webui/app/src/components/ui/index.ts` (MODIFIED)
Depends on: none
Done when: `tokens.css` registers `--dev-hue`/`--dev-sat`/`--dev-light`/`--dev-alpha`
via `@property` exactly per §C (syntax, `inherits: true`, initial values matching the
off/chassis state); `--glow-radius` is repurposed as the shared ambient-shadow blur
channel with a doc comment explaining the reuse; `--glow-hue`/`--glow-scale` are left
untouched and still unused; `globals.css` adds the `.dev-bleed` rule set from §C
(including the light-theme override) and the `springSnappy`-guarded reduced-motion
behavior described in §E; `lib/motion.ts` exports `springSnappy` (500/30) and
`springCelebrate` (260/12) alongside the three existing springs, unchanged; `lib/
device-bleed.ts` exports `useDeviceBleed(cardRef, hsl, power, brightness)` matching
§C's mechanism (imperative custom-property writes via `useMotionValueEvent`, no React
state churn per frame); `Panel` gains an additive `bleed?: boolean` prop (default
`false`); `Button`/`Slider`/`Dial`/`Switch` gain additive `tint`/`hue` props (default
`false`/`undefined`) that opt into `var(--dev-hue)`-driven styling per §D, with every
prop omitted producing pixel-identical output to today; `Button`'s `whileTap` (and
every other primitive's press transform) is guarded by `useReducedMotion()`, closing
the gap noted in §E; `Odometer` gains a `size="lg"` variant per §F's type scale,
default unchanged; `index.ts` re-exports any new types.
Verify: `npm run typecheck`; `npm run lint`; `npm run build` (passing is itself the
regression proof, since every new prop is additive/optional and no existing `<Button`/
`<Slider`/`<Dial`/`<Switch`/`<Panel`/`<Odometer` call site in the current tree passes
the new props); manual — `GOVEE_WEBUI_MOCK=1 npm run dev`, load the existing
(not-yet-updated-by-T16) dashboard and device console pages, confirm zero visual
change versus a pre-T15 screenshot, since none of these files are wired into any page
yet.

---

**T16 — Dashboard and shell composition**
Files: `webui/app/src/app/page.tsx` (MODIFIED), `webui/app/src/components/shell/
top-bar.tsx` (MODIFIED), `webui/app/src/components/shell/status-strip.tsx` (MODIFIED),
`webui/app/src/components/device/device-plate.tsx` (NEW, extracted from `page.tsx`),
`webui/app/src/components/device/groups-section.tsx` (NEW, extracted from `page.tsx`)
Depends on: T15
Done when: `DevicePlate` and the groups broadcast UI are extracted out of `page.tsx`
into the two new files and consume `useDeviceBleed` + `Panel`'s `bleed` prop so every
dashboard card tints its background/border/ambient shadow to the live device color per
§C, degrading to flat chassis when off/offline; the plate's instrument container uses
`aspect-ratio` sizing per §F instead of the fixed `h-28`; the quick-swatch + temp-preset
row becomes the horizontal-scroll channel-strip dock from §D; the brightness slider and
power switch on the plate use the new `tint`/`hue` props; `top-bar.tsx`'s icon buttons
pick up `springSnappy` press physics while its border/background/breadcrumb typography
stay on the exact unmodified chassis tokens (`--bg`/`--hairline`/`--text-low`/
`--text-mid`) per §G; `status-strip.tsx` gains the optional active-mode aggregate `Chip`
described in §D with no other visual change; the "first light" and "scene confirmed"
celebration moments from §E are wired to real power-toggle and ledger-confirmation
events on the dashboard grid; the stage-promotion View Transition from §E fires when
navigating from a card to its device console and gracefully no-ops under
`prefers-reduced-motion` or an unsupporting browser.
Verify: `npm run typecheck`; `npm run lint`; `npm run build`; manual with
`GOVEE_WEBUI_MOCK=1 npm run dev` — load the dashboard with the mock fleet (≥3 devices
with distinct colors) and confirm each card visibly tints toward its own device's
color with no cross-card bleed (i.e. `--dev-hue` does not leak past a card's own
`Panel` boundary — inspect two adjacent cards' computed styles in DevTools and confirm
they differ); toggle a mock device off and confirm its card's `.dev-bleed` background/
border/shadow return to the flat chassis baseline within one `--dur-slow` transition,
with no residual tint; using DevTools' contrast checker (or `npx @axe-core/cli` against
the running dev server if available), confirm `--text-hi` against a card's tinted
background at `--dev-alpha: 1` and the lightest mock device color (`#EAF2FF`) stays
≥4.5:1 in both themes; toggle a device off→on and confirm the one-shot particle burst
fires exactly once (not on every re-render/poll tick).
