"use client";

import * as React from "react";

/**
 * `Input` — the element a field is typed into.
 *
 * The sibling of `Pressable` (pressable.tsx) and `Select` (select.tsx):
 * it owns the ELEMENT and the CONTRACT, never the look. The look of a
 * field in this app is its `className` — the shared `INPUT_CLASS` chrome
 * (`app/settings/field.tsx`, `app/schedules/field.tsx`,
 * `components/rooms/authored-scene-dialog.tsx`,
 * `components/rooms/capture-room-dialog.tsx`) plus whatever the call site
 * varies (mono, uppercase, tabular figures, a narrower box). Those are
 * forwarded verbatim.
 *
 * It deliberately adds NO base class of its own. `cn()` is a plain string
 * join with no `tailwind-merge` (CLAUDE.md), so a base class here could
 * lose to a call site's own `h-*`/`w-*`/padding by emitted-rule order
 * alone — the exact hazard CLAUDE.md records for the `poll 10s` chip. A
 * component that adds nothing cannot reorder a rule.
 *
 * What it guarantees:
 *
 *   - **The one focus ring (#12).** The base layer paints the ring on every
 *     control, and the M2 gate bans a raw outline cancel outside
 *     `components/ui/`, so a promoted field keeps the ring.
 *   - **The 16px type under a coarse pointer (#8).** The call sites carry
 *     `pointer-coarse:text-base` themselves, so focusing a field never
 *     zooms the page on iOS; the promotion forwards that untouched.
 *   - **The 44px coarse hit area.** The call sites carry
 *     `pointer-coarse:h-11` / `pointer-coarse:min-h-11`; forwarded
 *     verbatim, so the promotion can never shrink a field's target.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * The presentational field. Forwarded ref, because a field that cannot be
 * focused programmatically is a field a keyboard test cannot reach.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ ...rest }, ref) {
    return <input ref={ref} {...rest} />;
  },
);
