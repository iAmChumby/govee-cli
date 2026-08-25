import type { NextConfig } from "next";

// Where the FastAPI sidecar lives. Overridable so a throwaway stack (the mock
// stack scripts/verify_ui.py boots, or two checkouts side by side) can run
// without colliding with the production services on the default ports.
const SIDECAR = process.env.GOVEE_WEBUI_API ?? "http://127.0.0.1:6057";

const nextConfig: NextConfig = {
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
