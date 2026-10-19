/**
 * The console's colour vocabulary — typed tokens with a single owner.
 *
 * #34 (CONSENSUS.md:240) closes the duplication point. The paint palette
 * used to be written out twice — `app/device/[ref]/color-picker.tsx` and
 * `components/panels/shared.tsx`, both as an untyped `readonly string[]` —
 * and the six quick colours a third time in `components/device/device-plate.tsx`.
 * Three copies of one decision is how a palette drifts, and a drifted
 * palette is a restyle no freeze can see. (The panels layer kept its own
 * copy only to avoid importing from the device-route folder; this module is
 * not in that folder, so both layers can read one owner.)
 *
 * One owner, literal types, and a compile-time proof that the quick six
 * are a subset of the paint ten — the debate's "six-of-ten subset"
 * (CONSENSUS.md correction 7).
 *
 * The values are frozen: `scripts/identity_styles.py` hashes this file as
 * an identity input, so changing a swatch fails `npm test`.
 */

/** The ten curated paint colours — saturated primaries plus both whites. */
export const PAINT_SWATCHES = [
  "#FF4545",
  "#FFA53D",
  "#FFD23D",
  "#46D06A",
  "#3DD6C4",
  "#3D7BFF",
  "#8A5CFF",
  "#FF5CA8",
  "#FFC978",
  "#EAF2FF",
] as const;

/** One paint colour, as a literal type. */
export type PaintSwatch = (typeof PAINT_SWATCHES)[number];

/**
 * The six quick colours on a device card and on a group row: the subset of
 * the paint ten that a one-tap control offers. `satisfies` makes the subset
 * a compile-time fact — a quick colour that is not in the palette is a type
 * error here, not a silently different swatch at runtime.
 */
export const QUICK_COLORS = [
  "#FF4545",
  "#FFA53D",
  "#FFD23D",
  "#46D06A",
  "#3D7BFF",
  "#EAF2FF",
] as const satisfies readonly PaintSwatch[];

/** One quick colour, as a literal type. */
export type QuickColor = (typeof QUICK_COLORS)[number];
