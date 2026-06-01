import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  compress: false, // Let nginx/CDN handle compression; required for SSE streaming
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        {
          key: "X-Frame-Options",
          value: "DENY",
        },
        {
          key: "X-Content-Type-Options",
          value: "nosniff",
        },
        {
          key: "Referrer-Policy",
          value: "strict-origin-when-cross-origin",
        },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
        {
          key: "X-DNS-Prefetch-Control",
          value: "on",
        },
        // Content-Security-Policy is set per-request in src/middleware.ts so it
        // can carry a script-src nonce (drops 'unsafe-inline' in production).
      ],
    },
  ],
};

export default withSentryConfig(nextConfig, {
  silent: true,
  tunnelRoute: "/monitoring",
});
