/**
 * `classifyActiveMode()` — the layered name resolver (WEBUI_V3_SPEC.md §4.5)
 * plus the non-name-driven `ActiveModeKind`s (`solid`, `segment_paint`,
 * `music_mode`, `effect`) that sit alongside it.
 *
 * Layer order, first match wins (§4.5, extended):
 *   1   curated exact-name table (`scene-appearance.ts`) — real-world
 *       research on what a NAMED scene/DIY mode actually looks like, keyed
 *       on the exact normalized name. Every entry is a human research pass,
 *       never device truth (the v2 API returns no colour data for any
 *       scene, ever — see that file's own doc comment). Only layer allowed
 *       to override the *archetype*.
 *   1.5 color-word palette override — applied independently of which
 *       archetype layer 1/2/3/4 picked (palette.ts owns the word table).
 *   2   keyword classifier, fixed priority.
 *   3   literal effect playback / statistical preview (only reachable when
 *       `kind === "effect"` — handled by `classifyEffectPreview` here and
 *       literally by `effect-playback.ts` at render time for the hero
 *       stage).
 *   4   INDETERMINATE fallback. Previously (the bug this replaced): an
 *       unmatched name hashed via `sum(charCode) % 4` into one of the
 *       archetypes' normal vivid default palettes — "aurora" summed to a
 *       bucket that happened to pick the lava-orange palette, a name with
 *       zero relation to lava, and rendered it with the same visual
 *       confidence as a real curated match (layer 1's `aurora` entry is the
 *       photographed-ground-truth fix: green/cyan). The hash is kept ONLY
 *       to vary the *motion* so unrelated unknown names don't all move
 *       identically — the palette it returns is now the fixed, desaturated
 *       `INDETERMINATE_PALETTE`, and `NameResolution.indeterminate`/
 *       `MotionSpec.paletteBasis` mark the result so callers (the caption,
 *       the library thumbnail) can say "we do not know" instead of implying
 *       a confident guess.
 */

import {
  colorWordInName,
  DEFAULT_PALETTE_FOR_ARCHETYPE,
  INDETERMINATE_PALETTE,
  normalizeName,
  paletteForColorWord,
  tokenizeName,
  VIVID_CHASE_PALETTE,
  WARM_BREATHE_PALETTE,
  paletteFromColor,
  paletteFromColorTempK,
  rgbToHex,
} from "./palette";
import { lookupSceneAppearance, type SceneAppearanceConfidence } from "./scene-appearance";
import { prefersColorTemp } from "@/components/stage/color";
import type { ActiveMode, EffectDescriptor, MotionArchetype, MotionSpec, Palette } from "./types";

/**
 * §4.6 gives a handful of named ground-truth rows a literal `periodSec` that
 * differs from their archetype's generic default (`DEFAULT_PERIOD_FOR_ARCHETYPE`)
 * without promoting them to a full layer-1 curated archetype/palette override —
 * `"make a calming, purple"` resolves its archetype via layer 2 ("calming" ->
 * `breathe`) and its palette via layer 1.5 (the "purple" color word), but the
 * table's own `periodSec` column for that row is `8`, not `breathe`'s generic
 * `6.5` (which must stay `6.5` elsewhere — it's the literal match to
 * `stage.tsx`'s existing CSS `Breath` cadence, the §4.1 zero-regression case).
 * Keyed by normalized (trimmed, lowercased) name, checked after the normal
 * layer 1/2/4 resolution so it never affects which archetype/palette is
 * chosen — only the acceptance-value period for this exact named case.
 */
const PERIOD_OVERRIDES: Record<string, number> = {
  "make a calming, purple": 8,
};

/* ------------------------------------------------------------------ layer 2 */

/** Fixed-priority keyword table (§4.5). First row whose keyword appears as
 *  a whole token in the normalized name wins. */
const KEYWORD_TABLE: { keywords: string[]; archetype: MotionArchetype }[] = [
  { keywords: ["fire", "candle"], archetype: "flicker" },
  { keywords: ["lava", "blob", "nebula"], archetype: "blob" },
  { keywords: ["wave", "ocean"], archetype: "wave" },
  { keywords: ["comet", "chase", "spin", "gaming", "game"], archetype: "chase" },
  { keywords: ["twinkle", "snow"], archetype: "sparkle" },
  { keywords: ["strobe", "disco"], archetype: "strobe" },
  { keywords: ["rain", "waterfall"], archetype: "rain" },
  { keywords: ["sunrise", "fade"], archetype: "gradient-drift" },
  { keywords: ["calm", "calming", "sleep", "relax"], archetype: "breathe" },
];

const DEFAULT_PERIOD_FOR_ARCHETYPE: Record<MotionArchetype, number> = {
  breathe: 6.5,
  blob: 55,
  plasma: 10,
  wave: 20,
  chase: 8,
  sparkle: 5,
  flicker: 3,
  strobe: 1.2,
  "gradient-drift": 45,
  rain: 6,
};

/* ------------------------------------------------------------------ layer 4 */

/**
 * §4.5 layer 4: `hash = sum(charCode for c of name.toLowerCase() where c is
 * alphanumeric) % 4`. Exported so classify.test.ts can assert the exact
 * §4.6 bucket values directly, independent of `classifyActiveMode`.
 */
export function hashBucket(name: string): 0 | 1 | 2 | 3 {
  const alnum = normalizeName(name).replace(/[^a-z0-9]/g, "");
  let sum = 0;
  for (let i = 0; i < alnum.length; i++) sum += alnum.charCodeAt(i);
  return (sum % 4) as 0 | 1 | 2 | 3;
}

/** 0→breathe, 1→gradient-drift, 2→blob, 3→wave — deliberately excludes
 *  strobe/sparkle so an unknown name never lands on something harsh. */
const HASH_ARCHETYPES: Record<0 | 1 | 2 | 3, MotionArchetype> = {
  0: "breathe",
  1: "gradient-drift",
  2: "blob",
  3: "wave",
};

/* ------------------------------------------------------------ name resolver */

export type ResolverLayer = 1 | 2 | 4;

export interface NameResolution {
  archetype: MotionArchetype;
  palette: Palette;
  periodSec: number;
  layer: ResolverLayer;
  /** true only for layer 4: no curated table entry and no keyword matched
   *  this name at all — the palette above is `INDETERMINATE_PALETTE`, not a
   *  guess dressed up as a confident one. Layers 1 and 2 both rest on real
   *  signal (a researched name match, or a keyword actually present in the
   *  name) and are never indeterminate, even though — per project law —
   *  they are still assumptions, not device truth. */
  indeterminate: boolean;
  /** How good the *colour* signal behind `palette` is, on
   *  scene-appearance.ts's own axis. A curated row carries its researched
   *  value verbatim ("high" = photographed/standard convention, "low" =
   *  read off the name with no corroboration); a keyword match is "medium"
   *  (the word really is in the name, but the palette is the archetype's
   *  generic default); layer 4 is `null` because `indeterminate` already
   *  says everything there is to say. Callers must not flatten a "low" row
   *  into the same wording as a "high" one — that is the distinction this
   *  table was written to carry, and dropping it would present a bare
   *  name-guess with photographed-ground-truth confidence. */
  paletteConfidence: SceneAppearanceConfidence | null;
}

/** Layers 1, 2 and 4 only (layer 1.5's palette override is applied by
 *  `resolveNamedPalette` below, and layer 3 is the separate effect-only
 *  path — `classifyEffectPreview`). Exported for direct testing against
 *  scene-appearance.ts and §4.6's table without going through the full
 *  `ActiveMode` shape. */
export function resolveByName(name: string): NameResolution {
  const curated = lookupSceneAppearance(name);
  if (curated) {
    return {
      archetype: curated.archetype,
      palette: curated.palette,
      periodSec: curated.periodSec,
      layer: 1,
      indeterminate: false,
      paletteConfidence: curated.confidence,
    };
  }

  const tokens = tokenizeName(name);
  for (const row of KEYWORD_TABLE) {
    if (row.keywords.some((kw) => tokens.includes(kw))) {
      return {
        archetype: row.archetype,
        palette: DEFAULT_PALETTE_FOR_ARCHETYPE[row.archetype],
        periodSec: DEFAULT_PERIOD_FOR_ARCHETYPE[row.archetype],
        layer: 2,
        indeterminate: false,
        paletteConfidence: "medium",
      };
    }
  }

  const bucket = hashBucket(name);
  const archetype = HASH_ARCHETYPES[bucket];
  return {
    archetype,
    palette: INDETERMINATE_PALETTE,
    periodSec: DEFAULT_PERIOD_FOR_ARCHETYPE[archetype],
    layer: 4,
    indeterminate: true,
    paletteConfidence: null,
  };
}

export interface NamedPaletteResolution {
  palette: Palette;
  /** false whenever a colour word (layer 1.5) or a curated/keyword match
   *  (layer 1/2) gave real signal about this name, even if the archetype
   *  itself came from the layer-4 hash — a colour word is real signal on
   *  its own, independent of which archetype it's paired with. */
  indeterminate: boolean;
  /** Same axis as `NameResolution.paletteConfidence`, describing the
   *  palette actually returned here — so a colour word that overrode a
   *  curated row reports the colour word's own standing, never the
   *  overridden row's. */
  paletteConfidence: SceneAppearanceConfidence | null;
}

/** Layer 1.5 applied to an already-resolved name. Split out from
 *  `resolveNamedPalette` so `classifyByNamedMode` resolves the name exactly
 *  once — calling both would run the whole layer stack twice and leave two
 *  places that could drift on what "indeterminate" means for one name. */
function paletteForResolution(name: string, resolved: NameResolution): NamedPaletteResolution {
  const colorWord = colorWordInName(name);
  if (colorWord) {
    // A literal colour word in the name is direct signal about hue,
    // stronger than a genre reading but never device truth — "medium".
    return { palette: paletteForColorWord(colorWord), indeterminate: false, paletteConfidence: "medium" };
  }
  return {
    palette: resolved.palette,
    indeterminate: resolved.indeterminate,
    paletteConfidence: resolved.paletteConfidence,
  };
}

/**
 * The exact palette + indeterminate flag `classifyByNamedMode` uses for a
 * name, factored out so `panels/shared.tsx`'s thumbnail gradient
 * (`nameToGradient`) can call the identical logic the 3D stage does — the
 * seam that fixes "Aurora renders green/cyan on the stage but a magenta
 * thumbnail in the library", two independent guesses that never agreed with
 * each other because they used to be two independent hashes.
 */
export function resolveNamedPalette(name: string): NamedPaletteResolution {
  return paletteForResolution(name, resolveByName(name));
}

function classifyByNamedMode(mode: ActiveMode): MotionSpec {
  const name = mode.name;
  if (!name) return classifySolid(mode);
  const resolved = resolveByName(name);
  const { palette, indeterminate, paletteConfidence } = paletteForResolution(name, resolved);
  const periodSec = PERIOD_OVERRIDES[normalizeName(name)] ?? resolved.periodSec;
  return {
    archetype: resolved.archetype,
    palette,
    periodSec,
    intensity: resolved.archetype === "strobe" ? 1 : 0.7,
    sourceName: name,
    paletteBasis: indeterminate ? "indeterminate" : "curated",
    ...(paletteConfidence ? { paletteConfidence } : {}),
  };
}

/* --------------------------------------------------------------- solid/segments */

function classifySolid(mode: ActiveMode): MotionSpec {
  // A device in colour-temperature mode reports a placeholder white alongside
  // the temperature that is actually lighting the room, so the temperature
  // wins that pair — see `basicHsl` in components/stage/color.ts.
  const rgb = mode.color ? ([mode.color.r, mode.color.g, mode.color.b] as const) : null;
  const tempK = mode.colorTempK ?? null;
  const palette =
    tempK !== null && prefersColorTemp(rgb, tempK)
      ? paletteFromColorTempK(tempK)
      : mode.color
        ? paletteFromColor(mode.color)
        : WARM_BREATHE_PALETTE;
  return {
    archetype: "breathe",
    // matches stage.tsx's existing Breath cadence (§4.1 zero-regression case)
    periodSec: DEFAULT_PERIOD_FOR_ARCHETYPE.breathe,
    intensity: 0.18,
    palette,
    sourceName: mode.name,
  };
}

function classifySegmentPaint(mode: ActiveMode): MotionSpec {
  // A segment paint is a static per-segment color command, not a running
  // animation — render as the same gentle breathe used for a plain solid
  // color, on whatever color is known.
  return classifySolid(mode);
}

/* --------------------------------------------------------------------- music */

interface MusicModeEntry {
  archetype: MotionArchetype;
  periodSec: number;
  palette?: Palette;
}

/**
 * §4.7's fixed hand-map, keyed by the resolved mode NAME — never the raw
 * per-model integer. H6056's `MUSIC_MODES` and H6022's are different
 * integer sets entirely (CLAUDE.md: "4 is `beat` here and `rolling`
 * there"); classifying by name is what keeps this table model-agnostic.
 */
const MUSIC_MODE_ARCHETYPES: Record<string, MusicModeEntry> = {
  vivid: { archetype: "plasma", periodSec: 6 },
  strike: { archetype: "chase", periodSec: 4 },
  rhythm: { archetype: "wave", periodSec: 3 },
  // "sparkle + flicker (composited)" — MotionSpec carries one archetype, so
  // this resolves to sparkle; the sparkle evaluator's own flicker-in/
  // flicker-out brightness jitter (`lamp3d/led-field.ts`, ported from the
  // deleted canvas renderer's identical curve) supplies the flicker half.
  vibrate: { archetype: "sparkle", periodSec: 2 },
  beat: { archetype: "breathe", periodSec: 0.55 }, // ~110bpm
  torch: { archetype: "flicker", periodSec: 3 },
  rainbowcircle: { archetype: "wave", periodSec: 6, palette: VIVID_CHASE_PALETTE },
  shiny: { archetype: "sparkle", periodSec: 3 },
};

function classifyMusicMode(mode: ActiveMode, model: string): MotionSpec {
  const key = mode.name ? normalizeName(mode.name) : "";
  const entry = MUSIC_MODE_ARCHETYPES[key];
  if (entry) {
    return {
      archetype: entry.archetype,
      palette: entry.palette ?? DEFAULT_PALETTE_FOR_ARCHETYPE[entry.archetype],
      periodSec: entry.periodSec,
      intensity: 0.85,
      sourceName: mode.name,
    };
  }
  if (process.env.NODE_ENV !== "production" && mode.name) {
     
    console.debug(
      `motion-engine: unmapped music mode "${mode.name}" on ${model}, falling back to the name resolver`,
    );
  }
  return classifyByNamedMode(mode);
}

/* -------------------------------------------------------------------- effect */

function hexToRgbTriplet(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

function rgbToHue([r, g, b]: [number, number, number]): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function uniqueColorsFromEffect(effect: EffectDescriptor, cap = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of effect.segments) {
    for (const kf of seg.keyframes) {
      const hex = kf.color.startsWith("#") ? kf.color.toLowerCase() : `#${kf.color.toLowerCase()}`;
      if (!seen.has(hex)) {
        seen.add(hex);
        out.push(rgbToHex(hexToRgbTriplet(hex)));
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

/** 0 (all one hue) .. 1 (opposite hues) — mean pairwise hue distance across
 *  the effect's own distinct colors, normalized. */
function colorVariance(colors: string[]): number {
  if (colors.length < 2) return 0;
  const hues = colors.map((c) => rgbToHue(hexToRgbTriplet(c)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      total += hueDelta(hues[i]!, hues[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs / 180;
}

/**
 * §4.5 layer 3's "compact preview" option: with real keyframe data in hand,
 * classify statistically off the effect's own color variance/hue-delta
 * rather than guess from a name — used for mini/plate stages and anywhere
 * else a `MotionSpec` (rather than literal per-frame playback) is needed.
 * The hero/full stage instead plays the effect back literally via
 * `effect-playback.ts`, bypassing this heuristic entirely (§4.5).
 */
function classifyEffectPreview(mode: ActiveMode): MotionSpec {
  const effect = mode.effect;
  if (!effect) return classifySolid(mode);
  const colors = uniqueColorsFromEffect(effect);
  if (colors.length === 0) return classifySolid(mode);
  const variance = colorVariance(colors);
  const archetype: MotionArchetype = colors.length === 1 ? "breathe" : variance > 0.35 ? "blob" : "gradient-drift";
  return {
    archetype,
    palette: { colors },
    periodSec: archetype === "breathe" ? DEFAULT_PERIOD_FOR_ARCHETYPE.breathe : 40,
    intensity: 0.6,
    sourceName: mode.name,
  };
}

/* ------------------------------------------------------------------ dispatch */

/**
 * The motion engine's single entry point (§4.4). `model` is accepted for API
 * symmetry with the geometry adapters and for dev-only traceability
 * (`classifyMusicMode`'s debug log) — it deliberately never affects the
 * name-driven layers 1/1.5/2/4's chosen archetype or palette, since the
 * hash fallback is name-stable, not device-stable, by design (§4.5): the
 * same DIY name must always render the same way regardless of which device
 * is playing it.
 */
export function classifyActiveMode(mode: ActiveMode, model: string): MotionSpec {
  switch (mode.kind) {
    case "solid":
      return classifySolid(mode);
    case "segment_paint":
      return classifySegmentPaint(mode);
    case "music_mode":
      return classifyMusicMode(mode, model);
    case "effect":
      return classifyEffectPreview(mode);
    case "firmware_scene":
    case "diy_scene":
      return classifyByNamedMode(mode);
    default:
      return classifySolid(mode);
  }
}
