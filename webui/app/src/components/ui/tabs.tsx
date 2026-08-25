"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/cn";
import { fadeFast, springStandard } from "@/lib/motion";

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

export function TabsList({
  className,
  ...rest
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
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
