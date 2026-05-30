import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import { decryptSourceUrl, decryptBytes } from "@/lib/content-encryption";
import { parseMediaBlob } from "@/lib/schemas/media-blob";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";

/**
 * Server-confirmed content-integrity flagging.
 *
 * A paying viewer's client (PaymentWall) couldn't decrypt this media and is
 * reporting the failure. We DO NOT trust that report on its own — a single
 * false client report must never take good content offline. Instead the
 * server re-runs the exact same decryption (same primitives the client uses)
 * and only flags `Media.status = error` when the SERVER also fails. Once
 * flagged, the viewer page short-circuits to "unavailable" and stops hitting
 * the SatsRail portal until an admin clears it.
 *
 * Patent boundary: this route reuses the already-issued macaroon and the
 * portal-returned key for an internal, server-side confirm decrypt. It returns
 * only `{ confirmed }` — never a key — so it does not merge payment
 * verification with key delivery (claim 4) and does not touch the
 * preimage→key path (claim 1). No new crypto: it calls existing
 * content-encryption.ts primitives only.
 */

/**
 * Allowlisted client failure reasons. Only these codes may be reported; any
 * other value is rejected, so no free text is ever persisted. Each maps to a
 * content-integrity failure in PaymentWall (resolveContent throws / checkout
 * fingerprint mismatch). Transient failures (e.g. envelope fetch 5xx) are
 * deliberately absent — the client must not report them.
 */
const ALLOWED_REASONS = new Set([
  "integrity_auth_failed",
  "key_fingerprint_mismatch",
  "missing_envelope_id",
  "key_length_invalid",
  "blob_too_short",
]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Decode a base64url string to raw bytes (mirrors content-encryption's decoder). */
function base64urlToBuffer(s: string): Buffer {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64");
}

/**
 * Re-run, server-side, the decryption the client attempted — using the same
 * content-encryption primitives. Returns true only when the server ALSO
 * cannot decrypt (integrity failure confirmed). Returns false when the server
 * succeeds (client failure was local/transient) or when we hit a condition we
 * don't want to over-flag on (a missing envelope ROW, which can be a transient
 * data state rather than corrupt content).
 *
 * Mirrors PaymentWall.resolveContent:
 *   url media        → single product-key decrypt
 *   photo / article  → product-key unwrap of the DEK, then DEK-decrypt of the
 *                      envelope bytes
 */
async function serverDecryptFails(
  mediaType: string,
  rawBlob: unknown,
  encryptedSource: string,
  key: string,
  productId: string
): Promise<boolean> {
  // url-backed media (video / audio / podcast): one product-key decrypt.
  if (mediaType !== "photo" && mediaType !== "article") {
    try {
      decryptSourceUrl(encryptedSource, key, productId);
      return false;
    } catch {
      return true;
    }
  }

  // Envelope-backed media (photo / article).
  let envelopeId: string;
  try {
    const blob = parseMediaBlob(rawBlob);
    if (blob.kind !== "photo" && blob.kind !== "article") {
      // Blob shape contradicts the media type — broken content.
      return true;
    }
    envelopeId = blob.envelopeId;
  } catch {
    // Blob fails to parse (e.g. missing envelopeId) — confirmed, matches the
    // client's missing_envelope_id path.
    return true;
  }

  let dekBytes: Buffer;
  try {
    const dekBase64url = decryptSourceUrl(encryptedSource, key, productId);
    dekBytes = base64urlToBuffer(dekBase64url);
  } catch {
    return true;
  }

  const envelope = await prisma.encryptedEnvelope.findUnique({
    where: { id: envelopeId },
    select: { bytes: true },
  });
  if (!envelope) {
    // Envelope row missing — ambiguous; do not flag on this alone.
    return false;
  }

  try {
    decryptBytes(envelope.bytes, dekBytes);
    return false;
  } catch {
    return true;
  }
}

export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;

  // The confirm path runs a portal verify + a server-side decrypt, so cap how
  // often one client can trigger it.
  const limited = await rateLimit("media_report_error", 20);
  if (limited) return limited;

  try {
    let body: { reason?: unknown; productId?: unknown; orderId?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!ALLOWED_REASONS.has(reason)) {
      return NextResponse.json({ error: "Unknown reason" }, { status: 400 });
    }
    const reportedProductId =
      typeof body.productId === "string" ? body.productId : undefined;
    const orderId = typeof body.orderId === "string" ? body.orderId : undefined;

    // Load media + channel — mirror the unlock route's guards.
    const media = await prisma.media.findUnique({
      where: { id },
      select: {
        id: true,
        channelId: true,
        mediaType: true,
        blob: true,
        status: true,
      },
    });
    if (!media) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }

    const channel = await prisma.channel.findUnique({
      where: { id: media.channelId },
      select: { active: true },
    });
    if (!channel || !channel.active) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    // Already flagged — acknowledge without re-confirming or hitting the
    // portal. (The viewer page short-circuits flagged media anyway, so this is
    // belt-and-suspenders.)
    if (media.status === "error") {
      return NextResponse.json({ confirmed: true, alreadyFlagged: true });
    }

    // Gate: only a paying viewer may report. This single portal verify also
    // yields the key we need for the server-side confirm decrypt.
    const products = await getProductsForMedia(media.id, media.channelId, {
      includeArchived: true,
    });
    if (products.length === 0) {
      return NextResponse.json(
        { error: "No product for this media" },
        { status: 404 }
      );
    }

    const productIds = products.map((p) => p.productId);
    const access = await verifyMacaroonAccess(productIds);
    if (!access.granted || !access.productId || !access.key) {
      return NextResponse.json({ error: "Payment required" }, { status: 401 });
    }

    const product = products.find((p) => p.productId === access.productId)!;
    if (!product.encryptedBlob) {
      // Nothing to decrypt — be conservative, don't flag.
      return NextResponse.json({ confirmed: false });
    }

    const confirmed = await serverDecryptFails(
      media.mediaType,
      media.blob,
      product.encryptedBlob,
      access.key,
      access.productId
    );

    if (!confirmed) {
      return NextResponse.json({ confirmed: false });
    }

    await prisma.media.update({
      where: { id: media.id },
      data: {
        status: "error",
        statusReason: reason,
        statusChangedAt: new Date(),
      },
    });

    await audit({
      actorType: "system",
      actorId: "",
      action: "media.decrypt_error",
      targetType: "media",
      targetId: media.id,
      details: { reason, productId: access.productId, reportedProductId, orderId },
    });

    return NextResponse.json({ confirmed: true });
  } catch (err) {
    console.error("report-error failure:", err);
    Sentry.captureException(err, {
      tags: { context: "media_report_error" },
      extra: { mediaId: id },
    });
    return NextResponse.json(
      { error: "Failed to process report" },
      { status: 500 }
    );
  }
}
