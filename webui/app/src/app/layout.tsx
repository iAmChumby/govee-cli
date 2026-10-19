import type { Metadata, Viewport } from "next";
import React from "react";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import "../styles/globals.css";
import { Providers } from "@/components/providers";
import { TopBar } from "@/components/shell/top-bar";
import { StatusStrip } from "@/components/shell/status-strip";
import { ClientNavTracker } from "@/components/ClientNavTracker";
import { SWRegister } from "@/components/SWRegister";

// UI + display — Archivo carries everything (display = weight 500–600,
// tracking −0.02em; no separate display face per spec §5.2)
const ui = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-ui-src",
  display: "swap",
});

// Data — IBM Plex Mono
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-src",
  display: "swap",
});

export const metadata: Metadata = {
  title: "filament — govee control console",
  description:
    "Self-hosted control console for Govee smart lights. Precision instruments for warm light.",
  /* #6: apple-touch-icon 180 from the Filament mark (the other icons ride
     the manifest at /manifest.webmanifest). */
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

/* #7 Safe-area insets: let the body lay out edge-to-edge so the --safe-*
   inset padding can move chrome clear of notches and the home indicator. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0e" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${ui.variable} ${mono.variable} font-ui`}>
        <Providers>
          <ClientNavTracker />
          <SWRegister />
          {/* Persistent app frame: chrome mounts once and survives every
              route change — no header replays, no status-strip resets. */}
          <div className="flex h-dvh flex-col overflow-hidden bg-bg">
            <TopBar />
            <div className="flex min-h-0 flex-1">{children}</div>
            <StatusStrip />
          </div>
        </Providers>
      </body>
    </html>
  );
}
