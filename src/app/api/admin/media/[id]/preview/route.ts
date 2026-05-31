import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { decryptEnvelopePayload } from "@/lib/media-envelope";

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
    select: {
      mediaType: true,
      name: true,
      envelope: { select: { id: true, bytes: true, wrappedDek: true } },
    },
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

  if (!media.envelope) {
    // No envelope yet (e.g. a url media not re-imported after the migration) —
    // nothing to preview. Return an empty source rather than 500 so the admin UI
    // degrades gracefully; the admin can set a URL via the edit form.
    return NextResponse.json({ source_url: "", media_type: media.mediaType });
  }

  // Recover the on-the-wire `source_url` by decrypting the media's envelope.
  //   url     → the source URL
  //   photo   → surface the envelope id pointer (bytes stay behind /api/envelopes/[id])
  //   article → the markdown body
  let sourceUrl: string;
  try {
    sourceUrl =
      media.mediaType === "photo"
        ? media.envelope.id
        : decryptEnvelopePayload(media.envelope).toString("utf8");
  } catch (err) {
    // Don't log the err object directly — exception messages from the
    // crypto layer can include byte offsets or key lengths that the Sentry
    // scrubber doesn't cover. Surface a generic 500 to the admin.
    console.error(
      `media.preview ${id}: failed to recover source_url (${err instanceof Error ? err.name : "unknown"})`
    );
    return NextResponse.json(
      { error: "Failed to decrypt content — check CONTENT_KEK configuration" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    source_url: sourceUrl,
    media_type: media.mediaType,
  });
}
