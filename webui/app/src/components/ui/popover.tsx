"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/cn";
import { fadeFast, springStandard } from "@/lib/motion";

interface PopoverContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext(): PopoverContextValue {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) throw new Error("Popover parts must be used inside <Popover>");
  return ctx;
}

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/** Radix Popover in the overlay language: stage radius, hairline
    border, single ambient shadow. */
export function Popover({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  children,
}: PopoverProps) {
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
    <PopoverContext.Provider value={{ open, setOpen }}>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </PopoverPrimitive.Root>
    </PopoverContext.Provider>
  );
}

export const PopoverTrigger = PopoverPrimitive.Trigger;

export interface PopoverContentProps
  extends Omit<
    React.ComponentProps<typeof PopoverPrimitive.Content>,
    "asChild" | "forceMount"
  > {
  children: React.ReactNode;
}

export function PopoverContent({
  className,
  sideOffset = 8,
  align = "end",
  children,
  ...rest
}: PopoverContentProps) {
  const { open } = usePopoverContext();

  return (
    <PopoverPrimitive.Portal>
      <AnimatePresence>
        {open ? (
          <PopoverPrimitive.Content
            forceMount
            asChild
            sideOffset={sideOffset}
            align={align}
            {...rest}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, transition: fadeFast }}
              transition={springStandard}
              className={cn(
                "z-50 w-72 rounded-stage border border-hairline bg-raised p-4 shadow-overlay",
                className,
              )}
            >
              {children}
            </motion.div>
          </PopoverPrimitive.Content>
        ) : null}
      </AnimatePresence>
    </PopoverPrimitive.Portal>
  );
}
