import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { decryptBytes } from "@/lib/content-encryption";
import { unwrapDek } from "@/lib/content-dek";
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
  //   url     → the URL as-is
  //   photo   → surface the EncryptedEnvelope.id pointer (bytes stay behind /api/envelopes/[id])
  //   article → decrypt the envelope on the fly and return the markdown body
  let sourceUrl: string;
  try {
    const parsed = parseMediaBlob(media.blob);
    if (parsed.kind === "url") {
      sourceUrl = parsed.url;
    } else if (parsed.kind === "photo") {
      sourceUrl = parsed.envelopeId;
    } else {
      const envelope = await prisma.encryptedEnvelope.findUnique({
        where: { id: parsed.envelopeId },
        select: { bytes: true },
      });
      if (!envelope) {
        return NextResponse.json(
          { error: "Envelope row missing — content unrecoverable" },
          { status: 500 }
        );
      }
      const dek = unwrapDek(parsed.encryptedDek);
      const plaintext = decryptBytes(envelope.bytes as Buffer, dek);
      sourceUrl = plaintext.toString("utf8");
    }
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
