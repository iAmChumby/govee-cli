/**
 * The curated "what does a scene named X actually look like" table.
 *
 * Project law (CLAUDE.md, "never claim what the device cannot tell you"):
 * the v2 API's scene list returns only `{name, paramId, id}`, the DIY list
 * only `{name, value}`, and `/device/state` reports "" for `lightScene`,
 * `diyScene` and `segmentedColorRgb` on every model, always. THERE IS NO
 * COLOUR DATA ON THE WIRE, EVER. Every entry below is a human research pass
 * over real Govee scene names — product photography, the app's own preview
 * thumbnails, community documentation, and (for `aurora`) a photograph of
 * this project's own H6022 running it — never a device read. `classify.ts`
 * and `panels/shared.tsx` both consume this table so the 3D stage and the
 * library thumbnail agree, and both are required to present the result as
 * an assumption (a caption/label naming it as such), never as confirmed
 * fact. A name with no entry here is not a research gap to paper over —
 * see `classify.ts`'s layer-4 fallback and `INDETERMINATE_PALETTE`
 * (palette.ts) for what happens instead.
 *
 * Each entry's `confidence` is this research pass's own honesty axis,
 * independent of the ledger's confidence field (which says whether the
 * *mode* is really running, not whether the *colour* guess is any good):
 *   - "high"   — a well-known/standard Govee convention, an anchor archetype
 *                explicitly specified elsewhere in this codebase, or (for
 *                `aurora`) photographed ground truth on real hardware.
 *   - "medium" — a reasonable reading of the name backed by a genre/seasonal
 *                convention (holiday palettes, movie-genre ambience, a
 *                named variant of a higher-confidence row).
 *   - "low"    — inferred purely from the name, with no corroboration at
 *                all. Still better than the old hash fallback (at least the
 *                guess is *about this specific name*), but the weakest tier
 *                this table offers.
 *
 * `basis` is a one-line note on why, always readable directly off the
 * returned object — never buried in a comment only visible in this file.
 */

import { normalizeName } from "./palette";
import type { MotionArchetype, Palette } from "./types";

export type SceneAppearanceConfidence = "high" | "medium" | "low";

export interface SceneAppearance {
  archetype: MotionArchetype;
  palette: Palette;
  periodSec: number;
  confidence: SceneAppearanceConfidence;
  basis: string;
}

interface SceneAppearanceEntry extends SceneAppearance {
  /** the exact display name this research was pinned to; lookup normalizes it */
  name: string;
}

const TABLE: readonly SceneAppearanceEntry[] = [
  {
    name: "Sunrise",
    archetype: "gradient-drift",
    palette: { colors: ["#1a1350", "#ff8a3d", "#ffe9c7"] },
    periodSec: 90,
    confidence: "high",
    basis: "classic Govee sunrise-alarm scene; indigo-to-amber-to-warm-white drift is the standard convention across their whole line",
  },
  {
    name: "Sunset",
    archetype: "gradient-drift",
    palette: { colors: ["#ff6a3d", "#c1256b", "#2b1a5e"] },
    periodSec: 90,
    confidence: "high",
    basis: "mirror of Sunrise, warm-to-indigo drift is Govee's standard sunset convention",
  },
  {
    name: "Rainbow",
    archetype: "chase",
    palette: { colors: ["#ff003c", "#ff9500", "#fff700", "#00ff85", "#00c3ff", "#7a00ff"] },
    periodSec: 8,
    confidence: "high",
    basis: "literal full-spectrum chase, unambiguous from the name",
  },
  {
    name: "Sunset Glow",
    archetype: "gradient-drift",
    palette: { colors: ["#ff9457", "#ff5f96", "#7a3dab"] },
    periodSec: 70,
    confidence: "medium",
    basis: "variant of Sunset with warmer pink emphasis implied by 'Glow'",
  },
  {
    name: "Aurora",
    archetype: "blob",
    palette: { colors: ["#1de9b6", "#00c896", "#39ff8f", "#7a4fff"] },
    periodSec: 50,
    confidence: "high",
    basis: "photographed ground truth: this project's own H6022 running Aurora is green/cyan with a violet edge, soft slow blob morph — NOT the lava-orange the old hash fallback produced",
  },
  {
    name: "Forest",
    archetype: "blob",
    palette: { colors: ["#1f7a3d", "#3fae5c", "#8fbf5e", "#d9a441"] },
    periodSec: 45,
    confidence: "high",
    basis: "anchor: greens with a warm dapple",
  },
  {
    name: "Ocean",
    archetype: "wave",
    palette: { colors: ["#0b3d91", "#1e9dd8", "#5fd0c9"] },
    periodSec: 22,
    confidence: "high",
    basis: "anchor: wave archetype, blues and teals",
  },
  {
    name: "Wave",
    archetype: "wave",
    palette: { colors: ["#0d6ba8", "#2ec4d6", "#bdf4f0"] },
    periodSec: 14,
    confidence: "high",
    basis: "anchor wave family; shorter period than Ocean to read as the more energetic of the two water scenes",
  },
  {
    name: "Snow flake",
    archetype: "sparkle",
    palette: { colors: ["#ffffff", "#cdeeff", "#8fd6ff"] },
    periodSec: 4,
    confidence: "high",
    basis: "anchor: sparkle archetype, icy white/blue",
  },
  {
    name: "Spring Wind",
    archetype: "wave",
    palette: { colors: ["#bff29a", "#eaffb0", "#fff6d8"] },
    periodSec: 18,
    confidence: "low",
    basis: "inferred purely from name: 'wind' implies a slow horizontal wave, pastel spring colors have no corroboration",
  },
  {
    name: "Sky",
    archetype: "gradient-drift",
    palette: { colors: ["#4fa8e0", "#bfe3ff", "#ffffff"] },
    periodSec: 50,
    confidence: "low",
    basis: "inferred purely from name: pale blue sky gradient with white cloud highlight, no corroboration",
  },
  {
    name: "Firefly",
    archetype: "sparkle",
    palette: { colors: ["#c9ff5e", "#ffe27a", "#1a2b12"] },
    periodSec: 6,
    confidence: "medium",
    basis: "firefly imagery implies warm sparkle on a dark green night backdrop",
  },
  {
    name: "Fire",
    archetype: "flicker",
    palette: { colors: ["#ff6a00", "#ffcf4d", "#ff2d00"] },
    periodSec: 3,
    confidence: "high",
    basis: "anchor: flicker archetype, orange/amber/deep red, ~3s",
  },
  {
    name: "Falling Petals",
    archetype: "rain",
    palette: { colors: ["#ffc2d9", "#ffe8f0", "#4f8a52"] },
    periodSec: 8,
    confidence: "medium",
    basis: "falling motion maps to the rain archetype; pink petal color is the obvious reading of the name",
  },
  {
    name: "Cherry blossoms",
    archetype: "blob",
    palette: { colors: ["#ffb7d1", "#ffe3ee", "#6fae6f"] },
    periodSec: 40,
    confidence: "medium",
    basis: "soft pink bloom with green accent, slower drifting blob rather than the harder rain-fall of Falling Petals",
  },
  {
    name: "Raining",
    archetype: "rain",
    palette: { colors: ["#4fa3ff", "#1c5aa8", "#0d2b52"] },
    periodSec: 5,
    confidence: "high",
    basis: "anchor: rain archetype, blues",
  },
  {
    name: "Desert",
    archetype: "gradient-drift",
    palette: { colors: ["#e0a458", "#c1440e", "#ffdca0"] },
    periodSec: 60,
    confidence: "low",
    basis: "inferred purely from name: sand/heat-haze gradient, no corroboration",
  },
  {
    name: "Karst Cave",
    archetype: "blob",
    palette: { colors: ["#0d3b3b", "#1e6e6e", "#3fae9e"] },
    periodSec: 45,
    confidence: "low",
    basis: "inferred purely from name: cave imagery suggests cool dim teal/blue-green slow morph, no corroboration",
  },
  {
    name: "Snowflake",
    archetype: "sparkle",
    palette: { colors: ["#ffffff", "#cdeeff", "#8fd6ff"] },
    periodSec: 4,
    confidence: "high",
    basis: "same convention as 'Snow flake': icy white/blue sparkle",
  },
  {
    name: "Romantic",
    archetype: "breathe",
    palette: { colors: ["#ff4d6d", "#ffb3c1"] },
    periodSec: 8,
    confidence: "medium",
    basis: "romantic mood lighting is conventionally a soft pink/red breathe",
  },
  {
    name: "Candlelight",
    archetype: "flicker",
    palette: { colors: ["#ffb14d", "#ff7a1a"] },
    periodSec: 2.5,
    confidence: "high",
    basis: "well-established Govee scene: warm amber flame flicker",
  },
  {
    name: "Movie",
    archetype: "breathe",
    palette: { colors: ["#3d4a8a", "#1a1f3d"] },
    periodSec: 10,
    confidence: "medium",
    basis: "ambient movie-watching backlight is conventionally dim cool blue, low distraction",
  },
  {
    name: "Reading",
    archetype: "breathe",
    palette: { colors: ["#ffe9c7", "#fff6e0"] },
    periodSec: 12,
    confidence: "medium",
    basis: "reading light convention is a steady warm-white glow, rendered as a very slow breathe",
  },
  {
    name: "Breathe",
    archetype: "breathe",
    palette: { colors: ["#ffb26b"] },
    periodSec: 6.5,
    confidence: "high",
    basis: "literal archetype name; matches the codebase's own WARM_BREATHE_PALETTE default",
  },
  {
    name: "Energetic",
    archetype: "plasma",
    palette: { colors: ["#ff003c", "#ff9500", "#fff700", "#00ff85"] },
    periodSec: 4,
    confidence: "medium",
    basis: "'energetic' implies a fast multi-hue plasma, consistent with music-mode Vivid's mapping",
  },
  {
    name: "Party",
    archetype: "strobe",
    palette: { colors: ["#ff003c", "#00c3ff", "#fff700", "#7a00ff"] },
    periodSec: 1,
    confidence: "medium",
    basis: "party lighting convention is a fast multi-color strobe/flash",
  },
  {
    name: "Siren",
    archetype: "strobe",
    palette: { colors: ["#ff0000", "#0033ff"] },
    periodSec: 0.8,
    confidence: "medium",
    basis: "siren imagery is unambiguous: alternating red/blue flash",
  },
  {
    name: "Asleep",
    archetype: "blob",
    palette: { colors: ["#2b2fb0", "#b0299a"] },
    periodSec: 60,
    confidence: "high",
    basis: "matches the codebase's own ground-truth SLEEP_BLOB_PALETTE for the 'sleep' name",
  },
  {
    name: "Crossing",
    archetype: "chase",
    palette: { colors: ["#ffcc00", "#000000", "#ffffff"] },
    periodSec: 5,
    confidence: "low",
    basis: "inferred purely from name: 'crossing' suggests a moving chase pattern, no corroboration",
  },
  {
    name: "Glitter",
    archetype: "sparkle",
    palette: { colors: ["#ffffff", "#ffd700", "#ffb3e6"] },
    periodSec: 4,
    confidence: "medium",
    basis: "glitter implies fast white/gold sparkle, consistent with other sparkle scenes",
  },
  {
    name: "Fright",
    archetype: "flicker",
    palette: { colors: ["#6a1b9a", "#1a0033", "#ff4500"] },
    periodSec: 2,
    confidence: "low",
    basis: "Halloween-adjacent name inferred as a jarring purple/orange flicker, no corroboration",
  },
  {
    name: "Drumbeat",
    archetype: "strobe",
    palette: { colors: ["#ff2d55", "#ffffff"] },
    periodSec: 0.6,
    confidence: "low",
    basis: "percussive name implies a hard-edged pulse synced to a beat, inferred purely from name",
  },
  {
    name: "Literary",
    archetype: "breathe",
    palette: { colors: ["#8a6a3d", "#e8d9b5"] },
    periodSec: 10,
    confidence: "low",
    basis: "movie-genre ambient scene, warm sepia/parchment tone inferred purely from name",
  },
  {
    name: "Sci-Fi",
    archetype: "plasma",
    palette: { colors: ["#00e5ff", "#7a00ff", "#0d1b3d"] },
    periodSec: 6,
    confidence: "low",
    basis: "movie-genre ambient scene, cool blue/violet inferred purely from name",
  },
  {
    name: "Romance",
    archetype: "breathe",
    palette: { colors: ["#ff4d6d", "#ffb3c1"] },
    periodSec: 8,
    confidence: "low",
    basis: "movie-genre duplicate of Romantic, same soft pink breathe inferred purely from name",
  },
  {
    name: "War",
    archetype: "flicker",
    palette: { colors: ["#8a1a1a", "#3d2b1a", "#ff6a00"] },
    periodSec: 3,
    confidence: "low",
    basis: "movie-genre ambient scene, inferred purely from name as a dark red/amber flicker",
  },
  {
    name: "Comedy",
    archetype: "plasma",
    palette: { colors: ["#ffd400", "#ff8a1e", "#00c3ff"] },
    periodSec: 5,
    confidence: "low",
    basis: "movie-genre ambient scene, inferred purely from name as a bright playful multi-hue",
  },
  {
    name: "Documentary",
    archetype: "breathe",
    palette: { colors: ["#8a8a6a", "#d9d0b5"] },
    periodSec: 12,
    confidence: "low",
    basis: "movie-genre ambient scene, inferred purely from name as a neutral warm-white breathe",
  },
  {
    name: "Action",
    archetype: "chase",
    palette: { colors: ["#ff003c", "#ff9500", "#000000"] },
    periodSec: 4,
    confidence: "low",
    basis: "movie-genre ambient scene, inferred purely from name as a fast red/orange chase",
  },
  {
    name: "Suspense",
    archetype: "flicker",
    palette: { colors: ["#1a0033", "#3d1a5e", "#6a0000"] },
    periodSec: 4,
    confidence: "low",
    basis: "movie-genre ambient scene, inferred purely from name as a dim dark-purple/red flicker",
  },
  {
    name: "Christmas",
    archetype: "sparkle",
    palette: { colors: ["#c1121f", "#0b6e2e", "#ffffff"] },
    periodSec: 5,
    confidence: "medium",
    basis: "conventional red/green/white holiday palette",
  },
  {
    name: "Halloween",
    archetype: "flicker",
    palette: { colors: ["#ff7518", "#4b0082", "#0a0a0a"] },
    periodSec: 3,
    confidence: "medium",
    basis: "conventional orange/purple Halloween palette",
  },
  {
    name: "Valentine",
    archetype: "breathe",
    palette: { colors: ["#ff4d6d", "#ff8fa3"] },
    periodSec: 8,
    confidence: "medium",
    basis: "conventional pink/red Valentine's palette",
  },
  {
    name: "New Year",
    archetype: "sparkle",
    palette: { colors: ["#ffd700", "#ffffff", "#c0c0c0"] },
    periodSec: 3,
    confidence: "medium",
    basis: "conventional gold/white/silver New Year's sparkle",
  },
  {
    name: "Independence Day",
    archetype: "strobe",
    palette: { colors: ["#c1121f", "#ffffff", "#1a3d8f"] },
    periodSec: 1,
    confidence: "medium",
    basis: "conventional red/white/blue patriotic palette",
  },
  {
    name: "St Patricks Day",
    archetype: "breathe",
    palette: { colors: ["#0b8f3d", "#3fae5c", "#ffd700"] },
    periodSec: 8,
    confidence: "medium",
    basis: "conventional green/gold St Patrick's Day palette",
  },
  {
    name: "Easter",
    archetype: "breathe",
    palette: { colors: ["#ffd6e8", "#d6f5ff", "#fff9c4"] },
    periodSec: 10,
    confidence: "medium",
    basis: "conventional pastel Easter palette",
  },
  {
    name: "Thanksgiving",
    archetype: "gradient-drift",
    palette: { colors: ["#c1440e", "#e0a458", "#6a3d1a"] },
    periodSec: 40,
    confidence: "medium",
    basis: "conventional autumn-harvest orange/brown palette",
  },
  {
    name: "Cherry Blossom",
    archetype: "blob",
    palette: { colors: ["#ffb7d1", "#ffe3ee", "#6fae6f"] },
    periodSec: 40,
    confidence: "medium",
    basis: "same reading as 'Cherry blossoms': soft pink bloom, slow drift",
  },
  {
    name: "Fireworks",
    archetype: "sparkle",
    palette: { colors: ["#ff003c", "#ffd700", "#00c3ff", "#ffffff"] },
    periodSec: 3,
    confidence: "high",
    basis: "well-known Govee scene family, bright multi-color bursts, fast sparkle",
  },
  {
    name: "Meteor",
    archetype: "chase",
    palette: { colors: ["#ffffff", "#8fd6ff", "#1a3d8f"] },
    periodSec: 3,
    confidence: "medium",
    basis: "shooting-star imagery conventionally reads as a fast bright chase across a dark blue field",
  },
  {
    name: "Waterfall",
    archetype: "rain",
    palette: { colors: ["#4fa3ff", "#a8e0ff", "#0d2b52"] },
    periodSec: 5,
    confidence: "medium",
    basis: "cascading water maps directly to the rain archetype",
  },
  {
    name: "Waves",
    archetype: "wave",
    palette: { colors: ["#0d6ba8", "#2ec4d6", "#bdf4f0"] },
    periodSec: 15,
    confidence: "high",
    basis: "plural of Wave, same reading",
  },
  {
    name: "Starlight",
    archetype: "sparkle",
    palette: { colors: ["#ffffff", "#cdeeff", "#8fa8ff"] },
    periodSec: 5,
    confidence: "medium",
    basis: "star imagery is a conventional cool-white sparkle",
  },
  {
    name: "Moonlight",
    archetype: "breathe",
    palette: { colors: ["#8fa8ff", "#dbe9ff"] },
    periodSec: 10,
    confidence: "medium",
    basis: "moonlight is conventionally a cool pale-blue steady glow",
  },
  {
    name: "Campfire",
    archetype: "flicker",
    palette: { colors: ["#ff6a00", "#ffcf4d", "#8a2d00"] },
    periodSec: 3,
    confidence: "high",
    basis: "same flicker family as Fire, well-established warm-hearth look",
  },
  {
    name: "Ember",
    archetype: "flicker",
    palette: { colors: ["#c1440e", "#ff8a1e", "#3d0d00"] },
    periodSec: 4,
    confidence: "medium",
    basis: "dying-fire imagery, slower dimmer flicker than an active Fire/Campfire",
  },
  {
    name: "Neon",
    archetype: "plasma",
    palette: { colors: ["#ff00e5", "#00fff7", "#faff00"] },
    periodSec: 4,
    confidence: "medium",
    basis: "neon-sign aesthetic is conventionally saturated magenta/cyan/yellow",
  },
  {
    name: "Cyberpunk",
    archetype: "plasma",
    palette: { colors: ["#ff00c8", "#00e5ff", "#7a00ff"] },
    periodSec: 4,
    confidence: "medium",
    basis: "cyberpunk aesthetic is conventionally magenta/cyan neon",
  },
  {
    name: "Vaporwave",
    archetype: "gradient-drift",
    palette: { colors: ["#ff77e9", "#8f77ff", "#77e9ff"] },
    periodSec: 30,
    confidence: "medium",
    basis: "vaporwave aesthetic is conventionally pastel pink/purple/teal, slow drift",
  },
  {
    name: "Retro Arcade",
    archetype: "chase",
    palette: { colors: ["#ff003c", "#00ff85", "#fff700", "#00c3ff"] },
    periodSec: 5,
    confidence: "low",
    basis: "arcade-cabinet imagery inferred as a bright multi-color chase, no corroboration",
  },
  {
    name: "Matrix",
    archetype: "chase",
    palette: { colors: ["#00ff41", "#003b00", "#000000"] },
    periodSec: 4,
    confidence: "high",
    basis: "'Matrix' falling-green-code aesthetic is culturally unambiguous",
  },
  {
    name: "Northern Lights",
    archetype: "blob",
    palette: { colors: ["#1de9b6", "#00c896", "#7a4fff"] },
    periodSec: 50,
    confidence: "medium",
    basis: "same phenomenon as Aurora, reusing the photographed ground-truth palette",
  },
  {
    name: "Galaxy",
    archetype: "blob",
    palette: { colors: ["#1a0d4d", "#4d1a8f", "#00c3ff"] },
    periodSec: 50,
    confidence: "medium",
    basis: "deep-space imagery conventionally reads as a slow indigo/violet/cyan blob morph",
  },
  {
    name: "Nebula",
    archetype: "blob",
    palette: { colors: ["#ff2d9e", "#7a00ff", "#00c3ff"] },
    periodSec: 55,
    confidence: "medium",
    basis: "nebula imagery conventionally reads as a vivid magenta/violet/cyan cloud morph",
  },
  {
    name: "Candy",
    archetype: "chase",
    palette: { colors: ["#ff5fa8", "#ffd400", "#00c3ff"] },
    periodSec: 5,
    confidence: "low",
    basis: "confectionery imagery inferred as bright multi-color, no corroboration",
  },
  {
    name: "Bubblegum",
    archetype: "breathe",
    palette: { colors: ["#ff8fc7", "#ffd6ea"] },
    periodSec: 6,
    confidence: "low",
    basis: "inferred purely from name as a soft pink breathe",
  },
  {
    name: "Cotton Candy",
    archetype: "breathe",
    palette: { colors: ["#ffb3e6", "#b3e6ff"] },
    periodSec: 8,
    confidence: "low",
    basis: "inferred purely from name as a soft pink/blue breathe",
  },
  {
    name: "Lava Lamp",
    archetype: "blob",
    palette: { colors: ["#ff4d1a", "#ffb703", "#c1121f"] },
    periodSec: 30,
    confidence: "medium",
    basis: "literal lava-lamp imagery matches the codebase's own generic lava blob default",
  },
  {
    name: "Fireplace",
    archetype: "flicker",
    palette: { colors: ["#ff6a00", "#ffcf4d", "#8a2d00"] },
    periodSec: 3,
    confidence: "high",
    basis: "same flicker family as Fire/Campfire, well-established warm-hearth look",
  },
  {
    name: "Rainy Day",
    archetype: "rain",
    palette: { colors: ["#6a8caf", "#0d2b52", "#c7d9e8"] },
    periodSec: 6,
    confidence: "medium",
    basis: "overcast/rainy imagery, muted grey-blue rain archetype",
  },
  {
    name: "Thunderstorm",
    archetype: "strobe",
    palette: { colors: ["#ffffff", "#1a1f3d"] },
    periodSec: 2,
    confidence: "medium",
    basis: "lightning flash against a dark stormy blue is a conventional strobe reading",
  },
  {
    name: "Wind Chimes",
    archetype: "sparkle",
    palette: { colors: ["#c7e8ff", "#ffffff"] },
    periodSec: 6,
    confidence: "low",
    basis: "delicate tinkling imagery inferred as a gentle pale sparkle, no corroboration",
  },
  {
    name: "Zen Garden",
    archetype: "breathe",
    palette: { colors: ["#9fbf8f", "#e8e0c7"] },
    periodSec: 12,
    confidence: "low",
    basis: "calm garden imagery inferred as a slow sage/sand breathe, no corroboration",
  },
  {
    name: "Tea Time",
    archetype: "breathe",
    palette: { colors: ["#d9a441", "#fff3d6"] },
    periodSec: 10,
    confidence: "low",
    basis: "cozy warm-amber imagery inferred purely from name",
  },
  {
    name: "Coffee House",
    archetype: "breathe",
    palette: { colors: ["#6a3d1a", "#c1904d"] },
    periodSec: 10,
    confidence: "low",
    basis: "warm-brown cafe-ambience imagery inferred purely from name",
  },
  {
    name: "Jazz Club",
    archetype: "breathe",
    palette: { colors: ["#8a1a3d", "#3d0d1a"] },
    periodSec: 8,
    confidence: "low",
    basis: "moody dim red/purple lounge imagery inferred purely from name",
  },
  {
    name: "Disco",
    archetype: "strobe",
    palette: { colors: ["#ff003c", "#00c3ff", "#fff700", "#7a00ff"] },
    periodSec: 0.8,
    confidence: "medium",
    basis: "disco-ball imagery conventionally reads as a fast multi-color strobe",
  },
  {
    name: "Karaoke Night",
    archetype: "strobe",
    palette: { colors: ["#ff2d9e", "#00c3ff", "#fff700"] },
    periodSec: 1,
    confidence: "low",
    basis: "party-adjacent imagery inferred as a bright multi-color strobe, no corroboration",
  },
  {
    name: "Game Night",
    archetype: "chase",
    palette: { colors: ["#ff003c", "#00ff85", "#00c3ff", "#fff700"] },
    periodSec: 4,
    confidence: "low",
    basis: "inferred purely from name as a playful multi-color chase, no corroboration",
  },
  {
    name: "Movie Night",
    archetype: "breathe",
    palette: { colors: ["#3d4a8a", "#1a1f3d"] },
    periodSec: 10,
    confidence: "low",
    basis: "same reading as Movie: dim cool ambient backlight",
  },
  {
    name: "Nightlight",
    archetype: "breathe",
    palette: { colors: ["#ffb26b", "#4a3d2b"] },
    periodSec: 15,
    confidence: "medium",
    basis: "nightlight convention is a very dim, very slow warm glow",
  },
  {
    name: "Relax",
    archetype: "breathe",
    palette: { colors: ["#7ec8ff", "#dbe9ff"] },
    periodSec: 10,
    confidence: "medium",
    basis: "relax mood lighting is conventionally a slow cool pale-blue breathe",
  },
  {
    name: "Focus",
    archetype: "breathe",
    palette: { colors: ["#ffffff", "#d6ecff"] },
    periodSec: 15,
    confidence: "medium",
    basis: "focus/work lighting is conventionally a steady bright cool white, rendered as a very slow breathe",
  },
  {
    name: "Sleep",
    archetype: "blob",
    palette: { colors: ["#2b2fb0", "#b0299a"] },
    periodSec: 60,
    confidence: "high",
    basis: "exact ground-truth 'sleep' name, matches the codebase's own curated layer-1 override",
  },
  {
    name: "Wake Up",
    archetype: "gradient-drift",
    palette: { colors: ["#1a1350", "#ff8a3d", "#ffe9c7"] },
    periodSec: 90,
    confidence: "high",
    basis: "same sunrise-alarm convention as Sunrise, indigo-to-amber-to-white",
  },
  {
    name: "Sunrise Circuit",
    archetype: "gradient-drift",
    palette: { colors: ["#1a1350", "#ff8a3d", "#ffe9c7"] },
    periodSec: 90,
    confidence: "medium",
    basis: "DIY name built on 'Sunrise', same indigo-to-amber-to-white drift convention",
  },
  {
    name: "Rainbow Flow",
    archetype: "chase",
    palette: { colors: ["#ff003c", "#ff9500", "#fff700", "#00ff85", "#00c3ff", "#7a00ff"] },
    periodSec: 8,
    confidence: "medium",
    basis: "DIY name built on 'Rainbow', same full-spectrum chase convention",
  },
  {
    name: "Ember Fade",
    archetype: "flicker",
    palette: { colors: ["#c1440e", "#ff8a1e", "#3d0d00"] },
    periodSec: 4,
    confidence: "medium",
    basis: "DIY name built on 'Ember', same dying-fire flicker convention",
  },
  {
    name: "Ocean Pulse",
    archetype: "wave",
    palette: { colors: ["#0b3d91", "#1e9dd8", "#5fd0c9"] },
    periodSec: 10,
    confidence: "medium",
    basis: "DIY name built on 'Ocean', shorter 'pulse' period than the base Ocean scene",
  },
  {
    name: "Cozy Glow",
    archetype: "breathe",
    palette: { colors: ["#ffb26b", "#ff7a3d"] },
    periodSec: 8,
    confidence: "medium",
    basis: "warm cozy imagery, matches the codebase's own WARM_BREATHE_PALETTE family",
  },
  {
    name: "Deep Sleep",
    archetype: "blob",
    palette: { colors: ["#2b2fb0", "#b0299a"] },
    periodSec: 70,
    confidence: "high",
    basis: "same reading as Sleep/Asleep, deeper/slower variant of the ground-truth sleep palette",
  },
];

const BY_NORMALIZED_NAME: ReadonlyMap<string, SceneAppearanceEntry> = new Map(
  TABLE.map((entry) => [normalizeName(entry.name), entry]),
);

if (BY_NORMALIZED_NAME.size !== TABLE.length) {
  // A duplicate normalized key would silently shadow one entry with
  // whichever comes later in TABLE — fail loudly at module load instead of
  // shipping a curated row nobody can reach.
  throw new Error("scene-appearance.ts: TABLE has a duplicate normalized name");
}

/**
 * Looks up curated real-world knowledge of what a scene/DIY name renders
 * as. Returns `null` when this research pass never covered the name — the
 * caller (classify.ts's layer-4 fallback) is responsible for treating that
 * as genuinely unknown, not for inventing something plausible-looking.
 */
export function lookupSceneAppearance(name: string): SceneAppearance | null {
  return BY_NORMALIZED_NAME.get(normalizeName(name)) ?? null;
}

/**
 * Every curated name, normalized. Exported for the guard test that keeps
 * this table and the resolver's layer 1.5 from silently fighting: a colour
 * word anywhere in a name overrides the palette chosen by every other
 * layer, including a researched row here, so a future entry called
 * e.g. "Green Forest" would have its photographed palette thrown away for
 * the generic green pair without a single test failing. The test names
 * that collision at the moment it is introduced.
 */
export const CURATED_SCENE_NAMES: readonly string[] = TABLE.map((entry) =>
  normalizeName(entry.name),
);
