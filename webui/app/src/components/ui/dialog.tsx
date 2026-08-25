"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";
import { fadeFast, springHeavy } from "@/lib/motion";

interface DialogContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("Dialog parts must be used inside <Dialog>");
  return ctx;
}

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Radix Dialog styled as a raised optical panel: stage radius, hairline
 * border, and the design system's single allowed soft ambient shadow.
 * Entrance scales 0.96→1 on the heavy spring; exit is faster.
 * `position="right"` renders a full-height sheet docked to the right edge.
 */
export function Dialog({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  children,
}: DialogProps) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const open = controlled ?? internal;

  const setOpen = React.useCallback(
    (v: boolean) => {
      if (controlled === undefined) setInternal(v);
      onOpenChange?.(v);
    },
    [controlled, onOpenChange],
  );

  return (
    <DialogContext.Provider value={{ open, setOpen }}>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  );
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps {
  /** center modal (default) or right-docked sheet */
  position?: "center" | "right";
  className?: string;
  children: React.ReactNode;
}

export function DialogContent({
  position = "center",
  className,
  children,
}: DialogContentProps) {
  const { open } = useDialogContext();

  return (
    <DialogPrimitive.Portal>
      <AnimatePresence>
        {open ? (
          <React.Fragment key="dialog">
            {/* dim backdrop */}
            <DialogPrimitive.Overlay forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: fadeFast }}
                transition={{ duration: 0.25 }}
                className="fixed inset-0 z-50"
                style={{ backgroundColor: "var(--scrim)" }}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content forceMount asChild>
              {position === "center" ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{
                    opacity: 0,
                    scale: 0.97,
                    y: 6,
                    transition: fadeFast,
                  }}
                  transition={springHeavy}
                  className="pointer-events-none fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4"
                >
                  {/* `place-items-center` inside a scrollable ancestor is a
                   * known cross-browser trap: once the child is taller than
                   * the viewport, the ancestor's scroll range only reaches
                   * toward the child's *end*, because the start of the range
                   * is defined by the centred position, not the child's own
                   * top edge. That permanently strands the title (WEBUI_V3_SPEC
                   * §11.6 T36) above the reachable scroll offset — a capture
                   * that returns unknown devices (title + description +
                   * warning block + two buttons) is the realistic worst case.
                   * Capping the panel's own height below the viewport means
                   * it can never be taller than its container, so the trap
                   * never triggers; the panel scrolls its own content
                   * instead. `dvh` (not `vh`) so iOS Safari's collapsing
                   * toolbar can't make the cap taller than what's actually
                   * visible, which is the same class of bug one layer down.
                   * `-2rem` matches the `p-4` gutter on the grid above so the
                   * cap never binds at 1440x900 — nothing in this app is
                   * currently tall enough to hit it there. */}
                  <div
                    className={cn(
                      "pointer-events-auto w-[min(92vw,480px)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-stage border border-hairline bg-panel p-6 shadow-overlay",
                      className,
                    )}
                  >
                    {children}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ x: "100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "100%", transition: fadeFast }}
                  transition={springHeavy}
                  className="pointer-events-none fixed inset-y-0 right-0 z-50 grid justify-items-end"
                >
                  {/* Same overlong-child problem one layer down: this panel
                   * had no internal scroll at all, so content taller than
                   * `h-full` simply overflowed past the box with nothing to
                   * bring the confirm button back into view. `max-h-[100dvh]`
                   * (not `-2rem` — this sheet is flush to the screen edges,
                   * unlike the padded centre dialog above) keeps `h-full`'s
                   * existing size on a static viewport and only tightens it
                   * when iOS Safari's toolbar makes the visible viewport
                   * shorter than `dvh`'s vh-based cousin would report. */}
                  <div
                    className={cn(
                      "pointer-events-auto h-full max-h-[100dvh] w-[min(92vw,420px)] overflow-y-auto rounded-l-stage border border-hairline border-r-0 bg-panel p-6 shadow-overlay",
                      className,
                    )}
                  >
                    {children}
                  </div>
                </motion.div>
              )}
            </DialogPrimitive.Content>
          </React.Fragment>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...rest
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "font-display text-lg font-medium leading-tight tracking-[-0.02em] text-hi",
        className,
      )}
      {...rest}
    />
  );
}

export function DialogDescription({
  className,
  ...rest
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-1.5 text-[13px] leading-relaxed text-mid", className)}
      {...rest}
    />
  );
}
