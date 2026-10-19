/**
 * The stage's rounded bottom corners, and the geometry of the paint-only
 * mask that restores them.
 *
 * ## Why a mask exists at all
 *
 * The 3D stage draws through one shared `WebGLRenderer` canvas mounted as a
 * `fixed` element outside the stage's DOM subtree, and each view is painted
 * into a square `gl.scissor` rect. A square rect cannot express a rounded
 * border, so at the stage's two bottom corners the render paints past the
 * rounded border onto whatever is behind it — where the lit ground plane is
 * opaque, that is a square corner on a rounded card.
 *
 * The stage's own `overflow-hidden` cannot clip it (the canvas is not in that
 * subtree) and a mask inside the stage cannot either: the stage's overflow
 * clips an outward `box-shadow` back to the rounded border, and at `lg` the
 * sticky `<section>` ancestor's stacking context keeps any child below the
 * body-level canvas. So the mask is a body-level `fixed` overlay of its own,
 * painting the two corner wedges in the surface colour that is behind them.
 *
 * ## Why it has to clip to the scroller
 *
 * That overlay is a body-level painter exactly like the canvas is, so it
 * inherits the canvas's one hard rule: a view clips to its scrolling
 * ancestor, or it paints over the TopBar (CLAUDE.md, "The 3D stage"). The
 * canvas is scissored to the intersection of the view's box and its
 * scrolling ancestor's box (`views.ts`'s `readBoxes`); the mask has to clip to
 * the same rect, or the wedge paints on the app's chrome while the canvas
 * underneath it correctly stops at the scroller's edge.
 *
 * The geometry here is deliberately pure and separately testable: the DOM
 * layer only supplies rectangles.
 */

/** A rectangle in viewport CSS pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The four `inset()` distances of a `clip-path`, in CSS pixels. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The intersection of two boxes, or `null` when they do not overlap.
 *
 * This is the same rule `views.ts`'s `intersectRect` applies to the canvas's
 * scissor rect: the view's box clipped to its scrolling ancestor's box.
 */
export function intersectBox(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The clip a corner mask needs, as `inset()` distances from its own border
 * box.
 *
 * Two things have to be true at once:
 *
 * 1. **Only the bottom half.** The mask paints through an outward
 *    `box-shadow`, and that shadow is a *ring* around the border box: it
 *    covers the bands above, below and beside the box as well as the two
 *    corner wedges inside it. Clipping to the bottom half of the border box
 *    leaves the wedges and drops every band outside the box — a band is a
 *    hundred pixels of flat colour painted over the page, and only the
 *    wedges are wanted.
 * 2. **Only inside the scroller.** `clip` is the rect the canvas scissors
 *    this view to. The mask's wedges must stop at the same edge, so a stage
 *    scrolled under the TopBar cannot paint its corner on the TopBar.
 *
 * The scroller's edge wins over the half-box rule when it is the stricter
 * one: a stage that is mostly scrolled out has only its bottom sliver
 * visible, and that sliver's wedge still has to be masked.
 */
export function maskClipInsets(mask: Box, clip: Box | null): Insets {
  const half = mask.height / 2;
  if (!clip) return { top: half, right: 0, bottom: 0, left: 0 };
  return {
    top: Math.max(half, clip.top - mask.top),
    right: Math.max(0, mask.left + mask.width - (clip.left + clip.width)),
    bottom: Math.max(0, mask.top + mask.height - (clip.top + clip.height)),
    left: Math.max(0, clip.left - mask.left),
  };
}

/** The `clip-path` value for a corner mask. */
export function maskClipPath(mask: Box, clip: Box | null): string {
  const i = maskClipInsets(mask, clip);
  return `inset(${i.top}px ${i.right}px ${i.bottom}px ${i.left}px)`;
}
