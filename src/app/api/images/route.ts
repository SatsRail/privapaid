import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE } from "@/lib/image-constants";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/images
 *
 * Generic image upload endpoint. The bytes go into the `PreviewImage` table —
 * the standalone image store for free-standing uploads — and the row id is
 * returned to the caller so it can be embedded via /api/images/{id}.
 *
 * Owner-specific images (channel avatar, media thumbnail, logo) have
 * dedicated POST endpoints that write directly to the owning row's Bytes
 * column. This route stays for free-standing images uploaded before the
 * owning row exists yet (e.g. preview gallery uploads during media
 * creation, ImageUpload component in admin forms).
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit("image_upload", 30);
  if (limited) return limited;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // Wrap everything past basic validation in a top-level try/catch so any
  // unhandled throw (sharp native binding missing, file-type module issue,
  // etc.) returns a JSON error rather than a Next default 500 HTML page —
  // which the client can't parse and reports as a generic "Upload failed"
  // with no detail.
  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Verify magic bytes match the claimed MIME type
    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected.mime)) {
      return NextResponse.json(
        { error: "File content does not match an allowed image type" },
        { status: 422 }
      );
    }

    // Validate image dimensions (max 8192x8192) to prevent decompression bombs
    const sharp = (await import("sharp")).default;
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
    } catch (err) {
      console.error("images.POST: sharp metadata read failed", err);
      const message = err instanceof Error ? err.message : "metadata error";
      return NextResponse.json(
        { error: `Unable to read image dimensions: ${message}` },
        { status: 422 }
      );
    }

    // Strip EXIF/IPTC/XMP metadata (privacy: removes GPS coordinates, camera
    // info, etc.). .rotate() applies EXIF orientation before stripping.
    let strippedBuffer: Buffer;
    try {
      strippedBuffer = await sharp(buffer).rotate().toBuffer();
    } catch (err) {
      console.error("images.POST: sharp re-encode failed", err);
      const message = err instanceof Error ? err.message : "Image processing failed";
      return NextResponse.json(
        { error: `Image processing failed: ${message}` },
        { status: 422 }
      );
    }

    // Standalone images live in the PreviewImage table — a generic blob
    // store with no FKs, separate from the EncryptedEnvelope table that
    // holds ciphertext for paid content. The caller embeds the returned id
    // via /api/images/{id}.
    const image = await prisma.previewImage.create({
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: strippedBuffer as any,
        mimeType: detected.mime,
      },
      select: { id: true },
    });

    return NextResponse.json(
      { image_id: image.id },
      { status: 201 }
    );
  } catch (err) {
    console.error("images.POST: unexpected failure", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Image upload failed: ${message}` },
      { status: 500 }
    );
  }
}
