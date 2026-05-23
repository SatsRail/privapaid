import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { getProductsForMedia, verifyMacaroonAccess } from "@/lib/access-gate";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import * as Sentry from "@sentry/nextjs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  try {

    await connectDB();

    const media = await Media.findById(id).select("channel_id").lean();
    if (!media) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }

    const channel = await Channel.findById(media.channel_id)
      .select("active")
      .lean();
    if (!channel || !channel.active) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const products = await getProductsForMedia(String(media._id), String(media.channel_id));

    if (products.length === 0) {
      return NextResponse.json(
        { error: "No product available for this media" },
        { status: 404 }
      );
    }

    const productIds = products.map((p) => p.productId);
    const access = await verifyMacaroonAccess(productIds);

    if (!access.granted || !access.productId) {
      return NextResponse.json(
        { error: "Payment required" },
        { status: 401 }
      );
    }

    const product = products.find((p) => p.productId === access.productId)!;

    // Increment view count (fire-and-forget — don't block the response)
    Media.updateOne({ _id: id }, { $inc: { views_count: 1 } }).catch(() => {});

    return NextResponse.json({
      key: access.key,
      key_fingerprint: access.keyFingerprint || product.keyFingerprint,
      encrypted_blob: product.encryptedBlob,
      product_id: product.productId,
      // Drives the access pill in MediaHeader. Without this the
      // useMediaAccess hook stores remainingSeconds=0, MediaHeader sees no
      // active time-gated access, and the price pill stays visible even
      // though content unlocked. The portal already returned the value via
      // verifyMacaroonAccess; we just need to propagate it.
      remaining_seconds: access.remainingSeconds ?? 0,
    });
  } catch (err) {
    console.error("Unlock error:", err);
    Sentry.captureException(err, { tags: { context: "unlock_endpoint" }, extra: { mediaId: id } });
    return NextResponse.json(
      { error: "Failed to fetch content key" },
      { status: 500 }
    );
  }
}
