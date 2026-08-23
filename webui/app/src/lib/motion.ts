import type { Transition, Variants } from "motion/react";

/**
 * App-wide motion vocabulary. Nothing snaps, ever.
 *
 * springStandard — controls, thumbs, indicators (260/26)
 * springHeavy    — panels, dialogs, sheets (170/22)
 * fadeFast       — exits and reduced-motion fallbacks (≤180ms)
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
