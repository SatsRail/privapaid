import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/config/instance";

// Served at /manifest.webmanifest. force-dynamic (like every page) so the
// operator's runtime instance name + theme colors land in the manifest rather
// than build-time defaults. A `display: standalone` manifest is what unlocks
// "Add to Home Screen" — required for Web Push on iOS Safari.
export const dynamic = "force-dynamic";

export async function GET() {
  const { name, theme } = await getInstanceConfig();

  const manifest = {
    name,
    short_name: name,
    start_url: "/",
    display: "standalone",
    background_color: theme.bg,
    theme_color: theme.primary,
    icons: [
      {
        src: "/favicon_io/android-chrome-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/favicon_io/android-chrome-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/favicon_io/android-chrome-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, s-maxage=3600",
    },
  });
}
