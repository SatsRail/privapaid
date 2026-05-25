import { NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request) {
  try {
    const settings = await prisma.settings.findFirst({
      where: { setupCompleted: true },
      select: { logoBytes: true, logoMimeType: true, logoUrl: true },
    });

    if (!settings || (!settings.logoBytes && !settings.logoUrl)) {
      return NextResponse.redirect(new URL("/favicon.ico", _req.url));
    }

    let logoBuffer: Buffer | null = null;
    if (settings.logoBytes) {
      logoBuffer = Buffer.from(settings.logoBytes);
    } else if (settings.logoUrl) {
      const res = await fetch(settings.logoUrl);
      if (res.ok) {
        logoBuffer = Buffer.from(await res.arrayBuffer());
      }
    }

    if (!logoBuffer) {
      return NextResponse.redirect(new URL("/favicon.ico", _req.url));
    }

    const favicon = await sharp(logoBuffer)
      .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    return new Response(new Uint8Array(favicon), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("Favicon generation error:", error);
    return NextResponse.redirect(new URL("/favicon.ico", _req.url));
  }
}
