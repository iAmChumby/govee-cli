import * as React from "react";

/**
 * Overflow-must-announce-itself (WEBUI_V3_SPEC.md §11.2): any horizontally
 * scrolling row needs a live edge affordance on the side that actually has
 * more content, and must stop showing it once that end is reached. §11.2's
 * inventory item (1) is what a *permanently-on* mask produces instead — the
 * channel strip's fade dissolves the divider whether or not there is more
 * to scroll to, so a phone reads a live control as a finished one. A static
 * `mask-image` cannot fix that; it has to react to real scroll position.
 *
 * `computeEdges` is split out as a pure function — and is the only part
 * that gets a unit test — because `vitest.config.ts` runs the node
 * environment with no jsdom (see `budget.ts`'s docblock for the repo
 * convention this follows): a hook that hides its arithmetic inside an
 * effect is untestable here, so the arithmetic lives outside the effect.
 */
export interface ScrollEdges {
  scrollable: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * `scrollWidth`/`clientWidth` are browser-reported and frequently carry a
 * sub-pixel residual even when a row visually fits exactly (e.g. 315.6 vs
 * 316) — treating any nonzero residual as "scrollable" makes the fade
 * flicker permanently on for a row with nothing to scroll to. A residual
 * under 2px is therefore "not scrollable" at all, and — independently —
 * a residual under 1px against either end counts as "at that edge", so
 * that rounding jitter during a real scroll doesn't strand the affordance
 * a fraction of a pixel short of the end.
 */
export function computeEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): ScrollEdges {
  const overflow = scrollWidth - clientWidth;
  const scrollable = overflow > 2;

  if (!scrollable) {
    return { scrollable: false, atStart: true, atEnd: true };
  }

  const atStart = scrollLeft < 1;
  const atEnd = scrollLeft > overflow - 1;

  return { scrollable, atStart, atEnd };
}

/**
 * Build a CSS `mask-image` gradient that fades the side(s) of a scrolling
 * row which have more content. Returns `undefined` when the row is not
 * scrollable, so the mask is absent entirely rather than permanently on.
 *
 * A static `mask-image` reads the same whether or not there is more content
 * to scroll to — it dissolved the divider even on a row that fit exactly,
 * which is §11.2 item (1)'s "clipped content reads as finished content"
 * defect. Fading only the side that has more content, and dropping the fade
 * on reaching it, turns the same visual language into an actual affordance.
 *
 * The gradient fades the row's own pixels to transparent rather than
 * layering paint on top, so this introduces no colour (§G / §11.4).
 *
 * It lives here, beside `computeEdges`, because it is the pure half of the
 * same contract: the arithmetic says which side has more content, this
 * turns that into the CSS. `tabs.tsx` and `status-strip.tsx` each carry
 * their own copy of this function today — the same rule, written out twice.
 * The dock imports this one; the other two are left alone because
 * `status-strip.tsx` is a frozen #34 identity input and closing that
 * duplication is not #9's scope.
 */
export function edgeMask(edges: ScrollEdges): string | undefined {
  if (!edges.scrollable) return undefined;
  const left = edges.atStart ? "black 0" : "transparent 0, black 20px";
  const right = edges.atEnd ? "black 100%" : "black calc(100% - 20px), transparent 100%";
  return `linear-gradient(to right, ${left}, ${right})`;
}

const UNMEASURED: ScrollEdges = { scrollable: false, atStart: true, atEnd: true };

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return (
    a.scrollable === b.scrollable && a.atStart === b.atStart && a.atEnd === b.atEnd
  );
}

/**
 * Recomputes `edges` on scroll, on container resize, and on content change.
 *
 * All three are load-bearing, and the third was learned the hard way. A
 * `ResizeObserver` on the scroll container fires when *that element's* box
 * changes — but both rows using this hook are `flex-1` children whose width
 * is set by their parent, so content growing inside them resizes nothing.
 * The status strip and the device tab rail both fill from React Query, which
 * means their content arrives *after* mount: the first and only measurement
 * ran against an empty row, concluded "fits", and the affordance never
 * appeared no matter how far the row later overflowed. The gate caught it as
 * a 167px overflow with no `data-scroll-affordance`, on every route.
 *
 * So a `MutationObserver` covers added/removed nodes and text changes (the
 * latency readout going from "— ms" to "27 ms" is a width change with no
 * DOM structure change at all), and `sameEdges` short-circuits the state
 * update — without it, a mutation-triggered `setEdges` with a fresh object
 * identity would re-render on every observation, and the mask style this
 * feeds would make that a loop worth avoiding.
 *
 * `edges.scrollable` starts `false` (the `UNMEASURED` default) so nothing
 * flashes an affordance on mount before the first real measurement lands.
 */
export function useEdgeScroll<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  edges: ScrollEdges;
} {
  const ref = React.useRef<T | null>(null);
  const [edges, setEdges] = React.useState<ScrollEdges>(UNMEASURED);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const next = computeEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
    };

    measure();

    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  return { ref, edges };
}
