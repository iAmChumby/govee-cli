"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { springStandard } from "@/lib/motion";

type ToastVariant = "ok" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms before auto-dismiss; default 4000 */
  duration?: number;
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
 * Bottom-right toast stack. Panels slide up and settle on a standard
 * spring; each carries a left-edge status bar by variant (sage / ember /
 * accent). Flat chrome — no shadow; bars carry all the signal.
 */
export function Toaster() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) return null;
  const { items, dismiss } = ctx;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-12 right-4 z-[100] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
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
            className="pointer-events-auto relative w-full overflow-hidden rounded-panel border border-hairline bg-raised"
          >
            <span
              aria-hidden
              className={cn(
                "absolute bottom-0 left-0 top-0 w-[3px]",
                BAR_CLASSES[item.variant],
              )}
            />
            <div className="py-3 pl-4 pr-9">
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
              className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-chip text-low transition-colors duration-150 hover:bg-accent-dim hover:text-hi"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
