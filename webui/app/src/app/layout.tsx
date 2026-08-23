import type { Metadata } from "next";
import React from "react";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import "../styles/globals.css";
import { Providers } from "@/components/providers";

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
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${ui.variable} ${mono.variable} font-ui`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
