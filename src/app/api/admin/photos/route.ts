import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE } from "@/lib/image-constants";
import { rateLimit } from "@/lib/rate-limit";
import { encryptBytes } from "@/lib/content-encryption";
import { wrapDek } from "@/lib/content-dek";

/**
 * POST /api/admin/photos
 *
 * Uploads a photo, encrypts it under a fresh random DEK (data encryption key),
 * stages the ciphertext as a MediaEnvelope row (mediaId null until the Media is
 * created and links it), and returns the envelope id + the DEK.
 *
 * The envelope also stores `wrappedDek` — the DEK wrapped under CONTENT_KEK — so
 * the bytes stay recoverable server-side for rotation/preview without a SatsRail
 * round-trip. The raw DEK is still returned to the client so create-product can
 * wrap it under the product key immediately.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit("photo_upload", 30);
  if (limited) return limited;

  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF" },
      { status: 422 }
    );
  }

  if (file.size > MAX_IMAGE_SIZE) {
    return NextResponse.json(
      { error: "File too large (max 5MB)" },
      { status: 422 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Verify magic bytes match the claimed MIME type (defense against
    // upload of arbitrary binaries with image MIME)
    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected.mime)) {
      return NextResponse.json(
        { error: "File content does not match an allowed image type" },
        { status: 422 }
      );
    }

    // Validate dimensions + strip EXIF before encryption (privacy preserved
    // even though the bytes will be encrypted at rest — exporters / future
    // decryptors shouldn't recover GPS metadata)
    const sharp = (await import("sharp")).default;
    let cleanBuffer: Buffer;
    try {
      const metadata = await sharp(buffer).metadata();
      if (
        metadata.width &&
        metadata.height &&
        (metadata.width > 8192 || metadata.height > 8192)
      ) {
        return NextResponse.json(
          {
            error: `Image too large: ${metadata.width}x${metadata.height} (max 8192x8192)`,
          },
          { status: 422 }
        );
      }
      cleanBuffer = await sharp(buffer).rotate().toBuffer();
    } catch (err) {
      console.error("admin.photos.POST: sharp processing failed", err);
      const message = err instanceof Error ? err.message : "Image processing failed";
      return NextResponse.json({ error: message }, { status: 422 });
    }

    // Generate a fresh per-photo DEK and encrypt the bytes
    const dek = randomBytes(32);
    const ciphertext = encryptBytes(cleanBuffer, dek);

    // Stage ciphertext as a MediaEnvelope row (mediaId null; linked when the
    // Media is created). `wrappedDek` is the CONTENT_KEK-wrapped DEK for
    // server-side recovery. Cast because Prisma's Bytes type wants
    // Uint8Array<ArrayBuffer> while Node's Buffer is Uint8Array<ArrayBufferLike>.
    const envelope = await prisma.mediaEnvelope.create({
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: ciphertext as any,
        mimeType: detected.mime,
        wrappedDek: wrapDek(dek),
      },
      select: { id: true },
    });

    // Convert DEK to base64url so it round-trips cleanly through JSON +
    // the existing encryptSourceUrl(string) primitive used to wrap it under
    // a product key.
    const dekBase64url = dek
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    return NextResponse.json(
      {
        // The legacy `gridFsId` name is preserved for client compatibility —
        // it's just an opaque envelope id from the client's perspective.
        gridFsId: envelope.id,
        dek: dekBase64url,
        mime: detected.mime,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("admin.photos.POST: unexpected failure", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Photo upload failed: ${message}` },
      { status: 500 }
    );
  }
}
