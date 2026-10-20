"use client";

import * as React from "react";

/**
 * `Pressable` — the element a finger or a key presses.
 *
 * `Button` (button.tsx) is the STYLED button: it owns a look (accent fill,
 * uppercase micro-label, a press-in spring) and takes a `variant` and a
 * `size`. `Pressable` is the other half: it owns the ELEMENT and the
 * CONTRACT, and never the look.
 *
 * Why both: M2 forbids a raw `<button>` outside `components/ui/`, and M3
 * (#30) is the wave that promotes feature code onto styled parts. This wave
 * is the step in between — the raw control leaves the feature file and
 * lands on a shared part, WITHOUT anything moving on screen. A styled
 * `Button` cannot do that job: its own base classes (uppercase, tracking,
 * weight, padding, height) would repaint 32 of the 34 call sites, and its
 * `motion.button` press-in would add a behaviour those sites never had.
 *
 * So `Pressable` adds no class of its own. It forwards every prop, every
 * `aria-*`, every `data-*`, every handler and the ref, and it renders a
 * plain `<button>` — the same element, the same attributes, the same
 * classes. The promotion is a move of the *element*, not of the *look*.
 *
 * What it guarantees:
 *
 *   - **The one focus ring (#12).** The base layer paints
 *     `:focus-visible { outline: var(--focus-ring-width) solid
 *     var(--focus-ring) }` for every control, so a promoted button keeps
 *     the ring; and the M2 gate bans a raw outline cancel outside
 *     `components/ui/`, so nothing may take it away. This component never
 *     cancels it either.
 *   - **The 44px coarse hit area.** The floor lives in the call site's own
 *     `pointer-coarse:` classes (`min-h-11`, `min-w-11`, `h-11`, `w-11`),
 *     and those are forwarded verbatim — the promotion can never shrink a
 *     hit area, because it never touches the class string. (12 of the 34
 *     promoted sites carry no coarse floor today; that is the tree's
 *     pre-existing state, and this component neither fixes nor worsens it.)
 *   - **`type="button"` by default**, so a promoted button cannot
 *     accidentally submit a form. Every promoted call site already said
 *     `type="button"`, so this changes nothing today.
 */
export type PressableProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * The presentational button. `React.forwardRef` because a control that
 * cannot be focused programmatically is a control a keyboard test cannot
 * reach.
 */
export const Pressable = React.forwardRef<HTMLButtonElement, PressableProps>(
  function Pressable({ type = "button", ...rest }, ref) {
    return <button ref={ref} type={type} {...rest} />;
  },
);
