import type { MetadataRoute } from "next";

/**
 * #6 — the web app manifest, served at /manifest.webmanifest by the
 * app/manifest.ts file convention. Icons are pre-rendered PNGs in
 * public/icons/ (generated from the Filament mark, src/app/icon.svg —
 * no runtime dependency needed).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "filament — govee control console",
    short_name: "filament",
    description:
      "Self-hosted control console for Govee smart lights. Precision instruments for warm light.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0c0e",
    theme_color: "#0b0c0e",
    orientation: "portrait-primary",
    scope: "/",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
    categories: ["utilities", "productivity"],
  };
}
