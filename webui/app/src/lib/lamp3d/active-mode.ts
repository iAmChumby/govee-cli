/**
 * The pure mode/honesty layer the 3D lamp stage renders from
 * (`docs/superpowers/specs/2026-08-25-3d-lamp-stage-design.md`).
 *
 * Everything here is a direct port of logic that used to live inline in
 * `components/stage/stage.tsx` (`motionModeMetaFor`, `motionSourceFor`,
 * `buildMotionActiveMode`, `formatAgeShort`, `activeModeCaption`,
 * `brightnessGlow`) — moved, not redesigned, so the GL stage and the CSS
 * stage agree on what a device is doing without duplicating the decision.
 *
 * The one deliberate extension over stage.tsx's own switch: this module's
 * `spec` is the SOLE driver of `led-field.ts`'s per-LED colour (a GL lamp has
 * no separate "just paint the chassis one flat colour" CSS layer to fall
 * back on the way stage.tsx's `EmissionLayers` did), so `off`/`basic` modes
 * — which stage.tsx's own `ActiveModeKind` doc comment already maps to
 * `"solid"` — get a real `MotionSpec` here too, built the exact same way
 * (`classifyActiveMode` -> `classifySolid`, which itself reads
 * `prefersColorTemp` from `color.ts`). stage.tsx never needed that spec
 * because its chassis was already painted from `basicHsl` directly in CSS;
 * the underlying colour decision is identical, just newly expressed as a
 * `MotionSpec` so `evaluateLedField` has exactly one input to read.
 *
 * The honesty UI (caption/chooser/reset) is NOT extended this way — it stays
 * gated on stage.tsx's original restricted set (scene/diy/music/snapshot/
 * segments/effect). A plain colour or temperature reads back from the cloud
 * at full confidence; captioning it "confirmed" on every device would be
 * decoration, not honesty, and stage.tsx never did that.
 *
 * PURE. No React, no three.js, no fetch — runs under plain Node vitest.
 */

import type { DeviceState, DeviceSummary } from "@/lib/api";
import { classifyActiveMode } from "@/lib/motion-engine/classify";
import type {
  ActiveMode as MotionActiveMode,
  ActiveModeKind as MotionActiveModeKind,
  EffectDescriptor,
  MotionSpec,
} from "@/lib/motion-engine/types";
import { clamp } from "@/components/stage/color";

/** The ledger's own merged read-side shape (api.ts `ActiveMode`), reached
 *  structurally off either state shape so this module never needs its own
 *  copy of the type. */
type LedgerActive = DeviceState["active"];

export interface ResolvedLampState {
  /** null when nothing may be claimed — renders zeroed LEDs, neutral chassis */
  spec: MotionSpec | null;
  /** Real per-segment keyframe data for literal effect playback (motion-engine
   *  §4.5 layer 3). Always null here: `PlayingEffect` lives behind its own
   *  `/effects/playing` fetch, entirely separate from `DeviceState`/
   *  `DeviceSummary`, and this module may not fetch anything (rule 5). The
   *  field exists so a caller that *has* fetched one can slot it in without
   *  changing this interface; until then `effect`-kind devices render the
   *  classified statistical preview `spec` already carries. */
  effect: EffectDescriptor | null;
  /** e.g. "sleep — DIY scene, assumed, 3h ago", or "unknown", or null when
   *  there is nothing honest to say (no ledger record read at all, or a
   *  plain colour/temperature that needs no caveat). */
  caption: string | null;
  /** true only when there is no ledger record at all (`active.mode ===
   *  "unknown"`) — the chooser exists to fix that absence. */
  showUnknownChooser: boolean;
  /** true only when a known non-basic/off mode is active — the reset needs a
   *  mode to reset FROM, which is exactly the chooser's opposite case. */
  showResetControl: boolean;
  power: boolean;
  brightness: number | null;
}

/** motion-engine's own classification input, plus the caption's human label
 *  ("scene" -> "sleep — scene"). Ported verbatim from stage.tsx. */
interface MotionModeMeta {
  kind: MotionActiveModeKind;
  label: string;
}

/**
 * Maps the ledger's `active.mode` to the motion engine's classification kind
 * for the RESTRICTED set stage.tsx already gave a canvas texture: a plain
 * `off`/`basic` colour needs no honesty caption (the cloud confirms it at
 * full confidence) and `unknown` needs the opposite UI (the chooser, not a
 * caption). Returns `null` for those three (and anything unrecognized) —
 * exactly stage.tsx's `motionModeMetaFor`, unchanged, because the
 * caption/chooser/reset gating below depends on this exact boundary.
 */
export function motionModeMetaFor(
  mode: LedgerActive["mode"] | undefined,
): MotionModeMeta | null {
  switch (mode) {
    case "scene":
      return { kind: "firmware_scene", label: "scene" };
    case "diy":
      return { kind: "diy_scene", label: "DIY scene" };
    case "music":
      return { kind: "music_mode", label: "music mode" };
    case "snapshot":
      return { kind: "solid", label: "snapshot" };
    case "segments":
      return { kind: "segment_paint", label: "segments" };
    case "effect":
      return { kind: "effect", label: "effect" };
    default:
      return null; // off | basic | unknown | undefined
  }
}

/** api.ts's `ActiveModeSource` ("cli"|"webui"|"schedule"|"group"|null) onto
 *  motion-engine's own `ActiveMode.source` ("ui"|"schedule"|"cli"|"group"|
 *  "unknown") — the two were named independently, this is the one place
 *  they need reconciling. Ported verbatim from stage.tsx. */
export function motionSourceFor(source: LedgerActive["source"]): MotionActiveMode["source"] {
  if (source === "webui") return "ui";
  return source ?? "unknown";
}

/**
 * Builds the motion engine's own `ActiveMode` input from the ledger's
 * merged `active` field plus the live-read colour/temp as the fallback
 * palette source for kinds (`solid`, and — via `classifySegmentPaint` —
 * `segment_paint`) that render off a single colour rather than a name.
 * Ported verbatim from stage.tsx, with one generalization: stage.tsx only
 * ever called this with a `kind` drawn from the restricted
 * `motionModeMetaFor` set; `resolveLampState` below also calls it with
 * `"solid"` for `off`/`basic`, which this function already supports (the
 * `kind` was always a parameter, never inferred from `active.mode` here).
 */
export function buildMotionActiveMode(
  state: DeviceState | DeviceSummary,
  active: LedgerActive,
  kind: MotionActiveModeKind,
): MotionActiveMode {
  return {
    kind,
    name: active.label ?? undefined,
    color: state.color ? { r: state.color.rgb[0], g: state.color.rgb[1], b: state.color.rgb[2] } : null,
    colorTempK: state.color_temp_k ?? null,
    confidence: active.confidence,
    ageSeconds: active.age_seconds,
    source: motionSourceFor(active.source),
  };
}

/** "3h ago" / "45s ago" — coarse, matches the caption's own low-precision
 *  register (this is a "how stale is this claim" cue, not a stopwatch).
 *  Ported verbatim from stage.tsx. */
export function formatAgeShort(seconds: number | null): string | null {
  if (seconds === null) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** e.g. `"sleep — DIY scene, assumed, 3h ago"`. Confidence is always spelled
 *  out verbatim (never softened, never omitted) so "assumed"/"external"/
 *  "unknown" can never be mistaken for "confirmed" at a glance. Ported
 *  verbatim from stage.tsx. */
export function activeModeCaption(active: LedgerActive, kindLabel: string): string {
  const head = active.label ? `${active.label} — ${kindLabel}` : kindLabel;
  const age = formatAgeShort(active.age_seconds);
  return [head, active.confidence, age].filter((part): part is string => Boolean(part)).join(", ");
}

/** Brightness as a 0..1 emission factor with a visible floor. Ported
 *  verbatim from stage.tsx; this is the single source both the CSS stage
 *  and the GL stage read brightness emission from. */
export function brightnessGlow(brightness: number | null): number {
  return 0.25 + 0.75 * (clamp(brightness ?? 50, 1, 100) / 100);
}

/**
 * Resolves everything the 3D lamp stage needs to render one device's honest
 * state — no cloud reads, no guessing what a stale field might mean.
 *
 * Order of decisions:
 *  1. No ledger record readable at all — `DeviceSummary.active` is `null`
 *     (failed read) or `undefined` (older sidecar) — renders exactly like
 *     `mode: "unknown"` for the LEDs/chassis, but stage.tsx never captioned
 *     or offered the chooser for this case either: there is no record to
 *     name as "unknown" and no ledger ref to fix, so caption stays `null`.
 *  2. `active.mode === "unknown"` — a REAL ledger entry saying "no idea" —
 *     gets the "unknown" caption and the chooser, because there IS
 *     something to fix now (a `PUT .../active-mode` call can correct it).
 *  3. Every other mode gets a real `MotionSpec` (rule 2: a running scene/
 *     diy/music/segment/effect mode is classified by name/kind and never
 *     reads `color`/`color_temp_k` back into the LED field, because those
 *     fields read back stale while such a mode runs; `off`/`basic` are
 *     classified as `"solid"`, which does read them, via `prefersColorTemp`
 *     — rule 3 — because for those two modes the fields are live truth).
 *     Caption/chooser/reset stay gated on stage.tsx's original restricted
 *     set (`motionModeMetaFor`), never on the wider `"solid"` fallback.
 */
export function resolveLampState(state: DeviceState | DeviceSummary): ResolvedLampState {
  const power = state.power === true;
  const brightness = state.brightness;

  // `DeviceSummary.active` is typed `?: ActiveMode | null` precisely because
  // a failed read can arrive as either shape (api.ts's own doc comment on
  // the field). Guard with truthiness, never `!== null` alone: `undefined
  // !== null` is `true`, which would let a missing record slip through the
  // "we know something" branch below.
  const active: LedgerActive | null | undefined = state.active;

  if (!active) {
    return {
      spec: null,
      effect: null,
      caption: null,
      showUnknownChooser: false,
      showResetControl: false,
      power,
      brightness,
    };
  }

  if (active.mode === "unknown") {
    return {
      spec: null,
      effect: null,
      caption: "unknown",
      showUnknownChooser: true,
      showResetControl: false,
      power,
      brightness,
    };
  }

  // Restricted mapping for the honesty UI (rule 4); `null` here means
  // `off`/`basic`, which still needs a `MotionSpec` (see module doc) but
  // never a caption/chooser/reset — those two modes are live truth, not an
  // assumption the ledger is making on the user's behalf.
  const restricted = motionModeMetaFor(active.mode);
  const kind: MotionActiveModeKind = restricted?.kind ?? "solid";
  const spec = classifyActiveMode(buildMotionActiveMode(state, active, kind), state.model ?? "");

  return {
    spec,
    effect: null,
    caption: restricted ? activeModeCaption(active, restricted.label) : null,
    showUnknownChooser: false,
    showResetControl: restricted !== null,
    power,
    brightness,
  };
}
