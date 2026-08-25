/**
 * Shared interfaces for the motion engine (WEBUI_V3_SPEC.md §4.4).
 *
 * This module is intentionally pure data — no React, no canvas calls, no
 * side effects — so every other file in `motion-engine/` (and its tests)
 * can depend on it without pulling in a DOM or React runtime.
 */

/** The 10 archetypes the renderer knows how to draw (§4.5). `breathe` is
 *  also the static-color fallback — the common case, unchanged from today's
 *  solid-color stage rendering. */
export type MotionArchetype =
  | "breathe"
  | "blob"
  | "plasma"
  | "wave"
  | "chase"
  | "sparkle"
  | "flicker"
  | "strobe"
  | "gradient-drift"
  | "rain";

export interface Palette {
  /** 2-6 stops, interpolation/blob-assignment order. e.g. sleep -> ["#2b2fb0", "#b0299a"] */
  colors: string[];
  /** optional under-layer tone; defaults to brightness-scaled black */
  base?: string;
}

/**
 * The motion engine's own classification input — mapped 1:1 from the
 * ledger's `mode` field (WEBUI_V3_SPEC.md §3): off/basic -> "solid",
 * scene -> "firmware_scene", diy -> "diy_scene", music -> "music_mode",
 * segments -> "segment_paint", effect -> "effect", snapshot -> "solid"
 * (snapshots have no motion of their own — treated as a static capture
 * until proven otherwise). This mapping happens at the integration point
 * (T12, stage.tsx), not inside this library.
 */
export type ActiveModeKind =
  | "solid"
  | "firmware_scene"
  | "diy_scene"
  | "music_mode"
  | "segment_paint"
  | "effect";

export interface EffectDescriptor {
  fps: number;
  loop: boolean;
  segments: { id: number; keyframes: { t: number; color: string }[] }[];
  /** epoch ms, from PlayingEffect.started_at */
  startedAt: number;
}

export interface ActiveMode {
  kind: ActiveModeKind;
  /** "sleep", "Ocean Wave", raw firmware/DIY name */
  name?: string;
  /** only when kind === "effect" */
  effect?: EffectDescriptor;
  color?: { r: number; g: number; b: number } | null;
  colorTempK?: number | null;
  confidence: "confirmed" | "assumed" | "external" | "unknown";
  ageSeconds: number | null;
  source: "ui" | "schedule" | "cli" | "group" | "unknown";
}

export interface MotionSpec {
  archetype: MotionArchetype;
  palette: Palette;
  /** full-cycle duration in seconds, archetype-specific meaning */
  periodSec: number;
  /** 0..1, independent of device brightness */
  intensity: number;
  /** stable key for the hash fallback / debug overlay */
  sourceName?: string;
}

export interface GeometryRegion {
  /** normalized 0..1 bounds within the stage's own canvas */
  bounds: { x: number; y: number; w: number; h: number };
  clip?: Path2D | ((ctx: CanvasRenderingContext2D, w: number, h: number) => void);
}

export interface DeviceGeometry {
  model: string;
  kind: "bars" | "matrix" | "orb";
  /** 2 for bars, 1 for the matrix drum, 1 for the orb */
  regions: GeometryRegion[];
}

/** driver.ts's per-stage registration (§4.4). `priority` feeds the
 *  hero+capped-plates concurrency tier (§4.1). */
export interface MotionFrameSubscriber {
  id: string;
  priority: "hero" | "plate";
  draw: (ctx: CanvasRenderingContext2D, t: number, dt: number) => void;
}
