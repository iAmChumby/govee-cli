import type { NextConfig } from "next";

// Where the FastAPI sidecar lives. Read at BUILD time, not at start time —
// Next bakes rewrites into the routes manifest, so setting this only when
// launching `next start` silently has no effect and the app keeps talking to
// whatever host was compiled in. scripts/verify_ui.py learned that the hard
// way: its "isolated mock stack" was driving the production sidecar.
const SIDECAR = process.env.GOVEE_WEBUI_API ?? "http://127.0.0.1:6057";

// Lets a throwaway build (the verification harness) live beside the deployed
// one instead of overwriting .next, which `govee-webui.service` is serving.
const DIST_DIR = process.env.GOVEE_WEBUI_DIST_DIR;

const nextConfig: NextConfig = {
  ...(DIST_DIR ? { distDir: DIST_DIR } : {}),
  async rewrites() {
    // Proxy API calls to the sidecar (never exposed publicly).
    return [
      {
        source: "/api/v1/:path*",
        destination: `${SIDECAR}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
