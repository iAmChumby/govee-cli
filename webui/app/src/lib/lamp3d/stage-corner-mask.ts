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

/**
 * A CSS background colour that can stand in for a surface.
 *
 * `getComputedStyle` reports an unset background as fully transparent, and
 * a transparent background is not a colour anything can be painted over.
 */
export function isPaintableBackground(css: string): boolean {
  return css !== "" && css !== "transparent" && css !== "rgba(0, 0, 0, 0)";
}

/**
 * The index of the first background in a chain that can be painted over, or
 * `-1` when the chain has none.
 *
 * The chain runs from the element the mask is imitating outwards: the
 * `.dev-bleed` panel when the stage sits on a card, else the stage's own
 * ancestors — the first opaque one is the surface the wedge has to match.
 */
export function pickBackgroundIndex(backgrounds: readonly string[]): number {
  for (let i = 0; i < backgrounds.length; i += 1) {
    if (isPaintableBackground(backgrounds[i])) return i;
  }
  return -1;
}

/**
 * The minimum an element must expose to be searched for a custom property.
 *
 * Structural on purpose: the search is pure and testable without a DOM.
 */
export interface InlineStyleHost {
  readonly parentElement: InlineStyleHost | null;
  readonly style: { getPropertyValue(property: string): string };
}

/**
 * The nearest ancestor (inclusive) whose **inline** style declares
 * `property`.
 *
 * This is the element that actually carries a device card's `--dev-hue` and
 * `--dev-alpha`: the card's own root, which `lib/device-bleed.ts` writes
 * them on. The `.dev-bleed` panel is that root's *child* and only inherits
 * them, so the panel's own attributes never change — reading the panel is
 * how the first version of the corner mask missed every tint change and
 * painted the corners in the untinted `--panel` colour.
 *
 * The card writes those properties in an effect that runs after the stage's
 * own, so the carrier is resolved lazily and re-resolved on every tick
 * until it appears.
 */
export function findInlineCarrier<T extends InlineStyleHost>(
  start: T | null,
  property: string,
): T | null {
  let el: InlineStyleHost | null = start;
  while (el) {
    if (el.style.getPropertyValue(property) !== "") return el as T;
    el = el.parentElement;
  }
  return null;
}

/** What the follower remembers between reads. */
export interface FollowState {
  /** The colour the mask is painted in right now. */
  colour: string;
  /** How many consecutive reads have seen that same colour. */
  settled: number;
}

/** What one read of the surface decided. */
export interface FollowStep {
  /** The colour the mask should be painted in now. */
  colour: string;
  /** Whether that is different from the colour it was painted in. */
  changed: boolean;
  /** Whether the follower should keep reading. */
  keepGoing: boolean;
  /** How many consecutive reads have now seen `colour`. */
  settled: number;
}

/**
 * One read of the card's surface colour.
 *
 * The card's background is a moving target — `--dev-hue`/`--dev-alpha` are
 * written on the card's root and the panel's background transitions over
 * `--dur-slow` — so the mask has to follow it rather than freeze the colour
 * it read at mount. But a settled card must cost nothing, so the follower
 * stops once the colour has stopped changing: `settledNeeded` consecutive
 * identical reads end the follow.
 */
export function stepFollow(
  state: FollowState,
  read: string,
  settledNeeded: number,
): FollowStep {
  const colour = isPaintableBackground(read) ? read : state.colour;
  const settled = colour === state.colour ? state.settled + 1 : 0;
  return { colour, changed: colour !== state.colour, keepGoing: settled < settledNeeded, settled };
}


