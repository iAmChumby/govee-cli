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
                  <div
                    className={cn(
                      "pointer-events-auto w-[min(92vw,480px)] rounded-stage border border-hairline bg-panel p-6 shadow-overlay",
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
                  <div
                    className={cn(
                      "pointer-events-auto h-full w-[min(92vw,420px)] rounded-l-stage border border-hairline border-r-0 bg-panel p-6 shadow-overlay",
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
