"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { springCelebrate, springStandard } from "@/lib/motion";
import type { DeviceHsl } from "@/lib/device-bleed";

type ToastVariant = "ok" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  deviceHsl?: DeviceHsl;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms before auto-dismiss; default 4000 */
  duration?: number;
  /**
   * Marks this toast as reporting a specific device's live action —
   * "scene confirmed" (V3_VISUAL_DIRECTION.md §D "Toasts" / §E) rather
   * than a system message. When set, the accent bar uses this color
   * instead of the fixed `variant` bar color and flares once with a
   * `springCelebrate` brightness pulse on mount before settling to
   * steady — the "this landed" tell. Omit for system/non-device toasts:
   * they render exactly as today, unconditionally.
   */
  deviceHsl?: DeviceHsl;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
  items: ToastItem[];
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const DEFAULT_DURATION = 4000;

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: ToastInput) => {
      const id = nextId++;
      const variant = input.variant ?? "info";
      setItems((prev) => [...prev.slice(-4), { id, ...input, variant }]);
      timers.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
          timers.current.delete(id);
        }, input.duration ?? DEFAULT_DURATION),
      );
    },
    [dismiss],
  );

  // Clear pending timers on unmount.
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = React.useMemo(
    () => ({ toast, dismiss, items }),
    [toast, dismiss, items],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

const BAR_CLASSES: Record<ToastVariant, string> = {
  ok: "bg-sage",
  error: "bg-ember",
  info: "bg-accent",
};

/**
 * The toast's left-edge accent bar. Fixed `variant` color by default
 * (today's behavior, unconditionally); when `deviceHsl` is set it fills
 * from that color instead and, on mount, flares once — `filter:
 * brightness()` spiking to 1.3× on `springCelebrate` before settling to
 * 1× — the "cloud caught up" tell §E describes. Reduced motion: the bar
 * still recolors (a color property, not motion) but skips the pulse,
 * per §E's explicit reduced-motion carve-out for this exact moment.
 */
function ToastBar({
  variant,
  deviceHsl,
}: {
  variant: ToastVariant;
  deviceHsl?: DeviceHsl;
}) {
  const reduced = useReducedMotion();

  if (!deviceHsl) {
    return (
      <span
        aria-hidden
        className={cn("absolute bottom-0 left-0 top-0 w-[3px]", BAR_CLASSES[variant])}
      />
    );
  }

  const [hue, sat, light] = deviceHsl;
  return (
    <motion.span
      aria-hidden
      className="absolute bottom-0 left-0 top-0 w-[3px]"
      style={{ backgroundColor: `hsl(${hue} ${sat}% ${light}%)` }}
      initial={reduced ? false : { filter: "brightness(1.3)" }}
      animate={{ filter: "brightness(1)" }}
      transition={springCelebrate}
    />
  );
}

/**
 * Bottom-right toast stack. Panels slide up and settle on a standard
 * spring; each carries a left-edge status bar by variant (sage / ember /
 * accent), or the reporting device's own color for a device-sourced toast
 * (see `ToastBar`). Flat chrome — no shadow; bars carry all the signal.
 */
export function Toaster() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) return null;
  const { items, dismiss } = ctx;

  return (
    <div
      aria-live="polite"
      // WEBUI_V3_SPEC.md §11.6 T35: at 390px the mobile layout is a
      // single column of full-width cards, and a `bottom-12 right-4`
      // toast up to 320px wide (82% of the screen) lands squarely over
      // whichever card the user just pressed — its controls stop
      // responding for the toast's full 4000ms `pointer-events-auto`
      // lifetime, for no reason the user can see. Below `md`, anchor the
      // stack under the top bar (48px, `top-bar.tsx`'s `h-12`) instead —
      // chassis, nothing interactive beneath it, so a toast parked there
      // can never cover a control. `max-md:` resets `bottom`→`top` and
      // widens the stack to the same 16px side margins the rest of the
      // mobile chrome uses; at `md` and up none of these fire and the
      // bottom-right corner stack is byte-identical to before (§11.1).
      className="pointer-events-none fixed bottom-12 right-4 z-[100] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col items-end gap-2 max-md:top-16 max-md:bottom-auto max-md:left-4 max-md:w-auto"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.id}
            layout
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              y: 6,
              scale: 0.98,
              transition: { duration: 0.15, ease: "easeOut" },
            }}
            transition={springStandard}
            // WEBUI_V3_SPEC.md §11.3/T35: the dismiss button is 24px. It
            // sits `absolute right-1.5 top-1.5`, so growing only its own
            // box under `pointer-coarse:` (via a `min-h`/`min-w` floor,
            // same reasoning as Button/IconButton) extends it down and
            // left from that fixed corner anchor — toward the card's
            // interior, never past the card's own right/top edge, so it
            // can't be clipped on those two sides regardless of content
            // length. The card itself needs a floor too, or a short
            // title-only toast (content height under ~40px) would let
            // `overflow-hidden` clip the *bottom* of a 44px button
            // anchored 6px from the top — `min-h-[52px]` guarantees
            // 6px inset + 44px button always fits inside the card's own
            // box on that axis.
            className="pointer-events-auto relative w-full overflow-hidden rounded-panel border border-hairline bg-raised pointer-coarse:min-h-[52px]"
          >
            <ToastBar variant={item.variant} deviceHsl={item.deviceHsl} />
            <div className="py-3 pl-4 pr-9 pointer-coarse:pr-[52px]">
              <p className="text-[13px] font-medium leading-snug text-hi">
                {item.title}
              </p>
              {item.description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-mid">
                  {item.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
              className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-chip text-low transition-colors duration-150 hover:bg-accent-dim hover:text-hi pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
