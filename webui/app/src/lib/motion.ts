import type { Transition, Variants } from "motion/react";

/**
 * App-wide motion vocabulary. Nothing snaps, ever.
 *
 * springStandard  — controls, thumbs, indicators (260/26)
 * springHeavy     — panels, dialogs, sheets (170/22)
 * springSnappy    — press-in physics (500/30)
 * springCelebrate — the two named celebration moments only (260/12)
 * fadeFast        — exits and reduced-motion fallbacks (≤180ms)
 */
export const springStandard: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 26,
};

export const springHeavy: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 22,
};

/** Press-in physics: buttons, switch thumb, slider thumb, dial knob on
    touch-down. Crisper than springStandard — a press should feel like it
    has more resistance than a value settling. Release still eases out on
    springStandard so it doesn't feel twitchy (V3_VISUAL_DIRECTION.md §E). */
export const springSnappy: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 30,
};

/** The two celebration moments only ("first light", "scene confirmed") —
    visibly overshoots once before settling, like a VU needle kicking.
    Never used for routine state changes (V3_VISUAL_DIRECTION.md §E/§G). */
export const springCelebrate: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 12,
};

export const fadeFast: Transition = { duration: 0.15, ease: "easeOut" };

/** Small rise-and-settle for list items, labels, inline reveals. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: springStandard },
};

/** Signature entrance for major panels — heavy, weighted settle. */
export const panelIn: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.99 },
  show: { opacity: 1, y: 0, scale: 1, transition: springHeavy },
};

/** Parent orchestrator: stagger children that use fadeUp/panelIn. */
export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};
