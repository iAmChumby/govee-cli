"use client";

import * as React from "react";

/**
 * `Select` — the element a field is chosen from.
 *
 * The third of the presentational trio (`Pressable`, `Input`, `Select`):
 * it owns the ELEMENT and the CONTRACT, never the look. A native select
 * in this app is the shared `INPUT_CLASS` chrome plus
 * `appearance-none pr-8` and a sibling `ChevronDown` glyph that draws the
 * arrow the native control no longer draws. Both the class string and the
 * children are forwarded verbatim.
 *
 * What it guarantees:
 *
 *   - **The one focus ring (#12).** The base layer paints the ring on every
 *     control, and the M2 gate bans a raw outline cancel outside
 *     `components/ui/`, so a promoted select keeps the ring.
 *   - **The 44px coarse hit area.** The call sites carry
 *     `pointer-coarse:h-11`; forwarded verbatim, so the promotion can
 *     never shrink a select's target.
 *
 * M3 (#30) names `Select` in its own part list; this is the presentational
 * half of it — the element and its contract, not the styled control the
 * slice-1 panels will be built from.
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * The presentational select. Forwarded ref, for the same reason as
 * `Input`: a control that cannot be focused programmatically is a control
 * a keyboard test cannot reach.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ children, ...rest }, ref) {
    return (
      <select ref={ref} {...rest}>
        {children}
      </select>
    );
  },
);
