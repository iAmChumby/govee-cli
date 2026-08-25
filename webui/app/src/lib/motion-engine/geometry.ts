/**
 * Per-model geometry adapters (WEBUI_V3_SPEC.md §4.2, §4.4, §4.8): bars
 * (2 regions), matrix (1 drum region), orb (1 region) — normalized 0..1
 * drawable bounds, shared by the hero (`variant: "full"`) and mini
 * (`variant: "mini"`) stage sizes since bounds scale correctly at either
 * size without adjustment.
 *
 * Mirrors `stage.tsx`'s own model dispatch (`BarsStage` for H6056,
 * `MatrixLampStage` for H6022, `OrbStage` otherwise) so the texture layer
 * lines up with the instrument it's drawn over. The exact rectangles are a
 * proportions of that layout's fixed-pixel instrument bodies (the H6022 drum is
 * 112x238 at full size, each H6056 tube 34x196, the H6008 bulb a 116px circle)
 * expressed against the stage box they sit in. They are close rather than
 * pixel-exact, because the instruments are fixed-size while these bounds are
 * normalized; the surrounding Halo is what sells the spill past the housing, so
 * the texture layer deliberately stays inside it.
 */

import type { DeviceGeometry, GeometryRegion } from "./types";

export type StageVariant = "full" | "mini";

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A region whose clip is the instrument's actual silhouette rather than its
 * bounding box.
 *
 * Without this the archetypes that fill their region edge to edge — gradient
 * drift, wave, plasma — painted a hard-edged rectangle of colour across the
 * stage with the lamp's outline floating on top of it. Blob archetypes hid the
 * problem because they fade out on their own. Clipping to the housing shape is
 * what makes every archetype read as light coming *out of the fixture* instead
 * of a coloured card sitting behind it.
 *
 * `radius` is in units of the region's own width, so one shape description
 * scales correctly between the hero stage and the pocket-sized plate.
 */
function roundedRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): GeometryRegion {
  return {
    bounds: { x, y, w, h },
    clip: (ctx, width, height) => {
      const rx = x * width;
      const ry = y * height;
      const rw = w * width;
      const rh = h * height;
      const r = Math.min(radius * rw, rw / 2, rh / 2);
      ctx.moveTo(rx + r, ry);
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
      ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      ctx.arcTo(rx, ry + rh, rx, ry, r);
      ctx.arcTo(rx, ry, rx + rw, ry, r);
      ctx.closePath();
    },
  };
}

/** An ellipse filling the region — the orb models' bulb. */
function ellipseRegion(x: number, y: number, w: number, h: number): GeometryRegion {
  return {
    bounds: { x, y, w, h },
    clip: (ctx, width, height) => {
      ctx.ellipse(
        (x + w / 2) * width,
        (y + h / 2) * height,
        (w / 2) * width,
        (h / 2) * height,
        0,
        0,
        Math.PI * 2,
      );
    },
  };
}

/** Two independent blob fields — one per light-bar tube, mirroring
 *  `BarsStage`'s `LightBar` pair (zones 0-2 left, 3-5 right). */
function barsGeometry(model: string): DeviceGeometry {
  return {
    model,
    kind: "bars",
    regions: [
      roundedRegion(0.30, 0.10, 0.11, 0.74, 0.5),
      roundedRegion(0.59, 0.10, 0.11, 0.74, 0.5),
    ],
  };
}

/** One drum region — the H6022's fabric shade. The 12x11 wrapped grid
 *  itself has no bearing on this texture layer; only the literal
 *  effect-playback path (`effect-playback.ts`) samples real per-segment
 *  color, and it addresses the same linear cloud-segment rail
 *  `SegmentRail` does, not individual matrix cells. */
function matrixGeometry(model: string): DeviceGeometry {
  return {
    model,
    kind: "matrix",
    regions: [roundedRegion(0.33, 0.10, 0.34, 0.72, 0.5)],
  };
}

function orbGeometry(model: string): DeviceGeometry {
  return {
    model,
    kind: "orb",
    regions: [ellipseRegion(0.33, 0.26, 0.34, 0.34)],
  };
}

/**
 * Builds the `DeviceGeometry` for a model. `variant` is accepted for API
 * symmetry with `useMotionStage` (§4.4) and to leave room for mini-specific
 * bound tuning later; bounds are normalized so they need no adjustment
 * between hero and plate sizes today.
 */
export function buildGeometry(model: string | null, variant: StageVariant = "full"): DeviceGeometry {
  void variant; // reserved for future mini-specific bound tuning — see doc comment above
  const m = model ?? "";
  if (m === "H6056") return barsGeometry(m);
  if (m === "H6022") return matrixGeometry(m);
  return orbGeometry(m || "unknown");
}

/** Normalized region bounds -> device pixel rect for a canvas of the given
 *  (already DPR-scaled) size. */
export function regionRectPx(region: GeometryRegion, width: number, height: number): PixelRect {
  return {
    x: region.bounds.x * width,
    y: region.bounds.y * height,
    w: region.bounds.w * width,
    h: region.bounds.h * height,
  };
}

/**
 * Clips the current path to a region: its custom `Path2D`/builder `clip` if
 * given, else a plain rect built from its normalized bounds. Callers should
 * `ctx.save()` before and `ctx.restore()` after.
 */
export function clipToRegion(
  ctx: CanvasRenderingContext2D,
  geometryRegion: GeometryRegion,
  width: number,
  height: number,
): void {
  if (geometryRegion.clip instanceof Path2D) {
    ctx.clip(geometryRegion.clip);
    return;
  }
  if (typeof geometryRegion.clip === "function") {
    ctx.beginPath();
    geometryRegion.clip(ctx, width, height);
    ctx.clip();
    return;
  }
  const rect = regionRectPx(geometryRegion, width, height);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
}
