import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Proxy API calls to the FastAPI sidecar (never exposed publicly).
    return [
      {
        source: "/api/v1/:path*",
        destination: "http://127.0.0.1:6057/api/v1/:path*",
      },
    ];
  },
};

export default nextConfig;
