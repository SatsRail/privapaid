import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { parseMediaBlob } from "@/lib/schemas/media-blob";

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
    select: { blob: true, mediaType: true, name: true },
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

  // Recover the on-the-wire `source_url` value from Media.blob.
  // Photo blobs surface the EncryptedPhotoBlob.id pointer (same as the
  // legacy shape — bytes themselves stay behind /api/photos/[id]).
  let sourceUrl = "";
  try {
    const parsed = parseMediaBlob(media.blob);
    if (parsed.kind === "url") sourceUrl = parsed.url;
    else if (parsed.kind === "markdown") sourceUrl = parsed.body;
    else sourceUrl = parsed.blobId;
  } catch {
    /* leave empty */
  }

  return NextResponse.json({
    source_url: sourceUrl,
    media_type: media.mediaType,
  });
}
