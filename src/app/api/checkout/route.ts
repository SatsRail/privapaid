import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";

export async function POST(req: Request) {
  try {
    const limited = await rateLimit("checkout", 20);
    if (limited) return limited;

    const result = await validateBody(req, schemas.checkout);
    if (isValidationError(result)) return result;

    const { media_id, product_id } = result;

    // Find the media and its channel
    const media = await prisma.media.findFirst({
      where: { id: media_id, deletedAt: null },
      select: { id: true, channelId: true },
    });
    if (!media) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }

    const channel = await prisma.channel.findFirst({
      where: { id: media.channelId, deletedAt: null },
      select: { active: true },
    });
    if (!channel || !channel.active) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    // Verify the product covers this media — works for both media-scoped
    // and channel-scoped products because every (product, media) pair has
    // a MediaProduct row in the unified shape.
    const blob = await prisma.mediaProduct.findFirst({
      where: {
        mediaId: media.id,
        product: { satsrailProductId: product_id },
      },
      select: { id: true },
    });
    if (!blob) {
      return NextResponse.json(
        { error: "Product not linked to this media" },
        { status: 400 }
      );
    }

    // Get global merchant key
    const sk = await getMerchantKey();
    if (!sk) {
      return NextResponse.json(
        { error: "Merchant API key not configured" },
        { status: 422 }
      );
    }

    // Fetch product from SatsRail to verify it's active and get its slug
    let productSlug: string;
    try {
      const product = await satsrail.getProduct(sk, product_id);
      if (product.status !== "active") {
        return NextResponse.json(
          { error: "Product is not available for purchase" },
          { status: 400 }
        );
      }
      productSlug = product.slug;
    } catch {
      return NextResponse.json(
        { error: "Product not found on SatsRail" },
        { status: 404 }
      );
    }

    // Create checkout session with product_id (slug) — the portal
    // resolves the product, sets amount/currency, and creates the session.
    const session = await satsrail.createCheckoutSession(sk, {
      checkout_session: {
        product_id: productSlug,
      },
    });

    return NextResponse.json({
      url: session.checkout_url,
      token: session.token,
    });
  } catch (err) {
    console.error("Checkout error:", err);
    Sentry.captureException(err, { tags: { context: "checkout_endpoint" } });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
