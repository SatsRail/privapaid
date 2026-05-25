import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const media = await prisma.media.findUnique({
    where: { id },
    select: { sourceUrl: true, mediaType: true, name: true },
  });

  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "media.preview",
    targetType: "media",
    targetId: id,
    details: { name: media.name },
  });

  return NextResponse.json({
    source_url: media.sourceUrl,
    media_type: media.mediaType,
  });
}
