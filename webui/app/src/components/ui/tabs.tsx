"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/cn";
import { fadeFast, springStandard } from "@/lib/motion";
import { useEdgeScroll, type ScrollEdges } from "@/lib/use-edge-scroll";

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
  layoutId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error("Tabs parts must be used inside <Tabs>");
  return ctx;
}

export interface TabsProps {
  defaultValue?: string;
  /** controlled value (optional) */
  value?: string;
  onValueChange?: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * Radix Tabs with a spring-animated accent underline that slides
 * between triggers via a shared layoutId.
 */
export function Tabs({
  defaultValue,
  value: controlled,
  onValueChange,
  className,
  children,
}: TabsProps) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const value = controlled ?? internal;
  const layoutId = React.useId();

  const setValue = React.useCallback(
    (v: string) => {
      if (controlled === undefined) setInternal(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange],
  );

  return (
    <TabsContext.Provider value={{ value, setValue, layoutId }}>
      <TabsPrimitive.Root
        value={value}
        onValueChange={setValue}
        className={className}
      >
        {children}
      </TabsPrimitive.Root>
    </TabsContext.Provider>
  );
}

/**
 * Builds the rail's edge fade from live scroll position (§11.6 T32) rather
 * than a permanently-on mask. §11.2 (2) is what a static mask produces: it
 * hid the scrollbar without putting anything in its place, so an H6056's
 * "…DIY  SNAPSHO" reads as a finished, clipped label rather than as "swipe
 * left" — the mask made the bug look intentional. Fading only the side
 * that has more content, and dropping that fade on reaching it, is what
 * turns the same visual language into an actual affordance. The mask
 * fades the rail's own pixels to transparent rather than layering any
 * paint on top, so this introduces no colour (§11.4/§G).
 */
function edgeMask(edges: ScrollEdges): string | undefined {
  if (!edges.scrollable) return undefined;
  const left = edges.atStart ? "black 0" : "transparent 0, black 20px";
  const right = edges.atEnd ? "black 100%" : "black calc(100% - 20px), transparent 100%";
  return `linear-gradient(to right, ${left}, ${right})`;
}

export function TabsList({
  className,
  style,
  ...rest
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  const { ref, edges } = useEdgeScroll<HTMLDivElement>();
  const mask = edgeMask(edges);

  return (
    <TabsPrimitive.List
      ref={ref}
      // Read by scripts/viewport_audit.py to confirm a scrolling row was
      // deliberately given an affordance rather than left bare (§11.6 T32).
      // Present only while the row actually overflows, so it can't lie
      // about a rail that currently fits.
      data-scroll-affordance={edges.scrollable ? "true" : undefined}
      // Scrolls rather than wraps. At 390px the device console's six tabs
      // ("Paint Studio" among them) do not fit, and a wrapping row broke the
      // label across two lines while clipping the last tab's text — a control
      // that looks like a rendering bug. Horizontal scroll keeps every label
      // whole and reachable; `scrollbar-none` hides the bar on desktop where
      // the row usually fits anyway.
      className={cn(
        "flex items-end gap-5 overflow-x-auto scrollbar-none border-b border-hairline",
        "[&>*]:shrink-0",
        className,
      )}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      {...rest}
    />
  );
}

export interface TabsTriggerProps
  extends React.ComponentProps<typeof TabsPrimitive.Trigger> {
  value: string;
}

export function TabsTrigger({ value, className, children, ...rest }: TabsTriggerProps) {
  const ctx = useTabsContext();
  const active = ctx.value === value;

  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "relative cursor-pointer pb-2 pt-1 text-[11px] uppercase tracking-micro transition-colors duration-150",
        // §11.3: every interactive element needs >=44x44 CSS px of hit
        // area under a coarse pointer — today's trigger is ~24px tall
        // (11px label + 12px of padding). `min-h-11` plus centring grows
        // the box via padding rather than an oversized overlay (§11.1's
        // ban on `::after` bigger than the laid-out box: on a 5-wide tab
        // rail an overlay would overlap the next trigger's hit rectangle,
        // stealing its taps). Guarded by `pointer-coarse:` so a fine-
        // pointer desktop never evaluates it — the row's laid-out height
        // and the underline's position at fine pointer are untouched,
        // which is the whole point of the gate in §11.1.
        "pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center",
        // Height alone leaves width short: the trigger has no horizontal
        // padding today (only `pb-2 pt-1`, both vertical), so "DIY" is
        // exactly its 3-character text run — measured ~24px — and "Light"
        // ~41px. `px-3` adds 12px on each side, so the narrowest label
        // (DIY, 24px) reaches 48px — 4px of buffer past the 44px floor
        // rather than landing exactly on it, because tabs.tsx already has
        // one instance in this file of a size that cleared the height
        // threshold but not the width one, and the buffer is cheap.
        // Longer labels ("Paint Studio") just get proportionally wider,
        // which is fine per the task: the rail already scrolls with a
        // live edge affordance (§11.6 T32 above), so a few more px of
        // horizontal travel costs nothing but a touch more swiping. Padding
        // is symmetric, so it centres each label inside its own wider box
        // without a separate `justify-center` — no flex distribution is
        // involved since each trigger sizes to its own content+padding.
        // `pointer-coarse:` gates this exactly as it gates the height
        // rule: a mouse-driven 1440x900 desktop never matches the media
        // query, so the rail's fine-pointer width (and therefore its
        // total row width and every sibling's x-position) is unchanged —
        // the same reasoning §11.1 requires for the height fix above.
        "pointer-coarse:px-3",
        active ? "text-hi" : "text-mid hover:text-hi",
        className,
      )}
      {...rest}
    >
      {children}
      {active ? (
        <motion.span
          layoutId={`${ctx.layoutId}-ink`}
          transition={springStandard}
          className="absolute inset-x-0 -bottom-px h-px bg-accent"
        />
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export interface TabsContentProps
  extends Omit<React.ComponentProps<typeof TabsPrimitive.Content>, "value"> {
  value: string;
}

export function TabsContent({
  value,
  className,
  children,
  ...rest
}: TabsContentProps) {
  const ctx = useTabsContext();
  const active = ctx.value === value;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {active ? (
        <TabsPrimitive.Content
          key={value}
          value={value}
          forceMount
          tabIndex={-1}
          className={cn("outline-none", className)}
          {...rest}
        >
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: fadeFast }}
            transition={springStandard}
          >
            {children}
          </motion.div>
        </TabsPrimitive.Content>
      ) : null}
    </AnimatePresence>
  );
}
