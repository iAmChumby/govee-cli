"use client";

import * as React from "react";
import { MotionConfig } from "motion/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

import { ToastProvider, Toaster } from "@/components/ui/toaster";

/**
 * App-wide providers: next-themes (class strategy, dark default),
 * MotionConfig honoring prefers-reduced-motion, TanStack Query with a
 * 5s staleTime, and the toast system with its mounted stack.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            {children}
            <Toaster />
          </ToastProvider>
        </QueryClientProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
