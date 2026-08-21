import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { validateBody, isValidationError, schemas } from "@/lib/validate";
import { rateLimit } from "@/lib/rate-limit";
import * as Sentry from "@sentry/nextjs";
import config from "@/config/instance";

/**
 * Translate a failed product lookup into a response that names the actual
 * problem. Only a real 404 from the portal means "product not found" — an
 * unreachable host, a rejected merchant key or a portal 5xx are different
 * failures with different fixes, and collapsing them all into a 404 is what
 * made an unresolvable SATSRAIL_API_URL so hard to diagnose from the UI.
 */
function satsrailLookupFailure(err: unknown, productId: string): NextResponse {
  // SatsRailApiError carries the HTTP status; a transport failure (DNS,
  // TLS, connection refused, timeout) has none. Read it structurally so this
  // stays correct regardless of how the client module is wired up.
  const raw = (err as { status?: unknown } | null)?.status;
  const httpStatus = typeof raw === "number" ? raw : null;
  const apiUrl = config.satsrail.apiUrl;

  console.error(
    `Checkout: SatsRail product lookup failed for ${productId} via ${apiUrl}`,
    err
  );
  Sentry.captureException(err, {
    tags: {
      context: "checkout_product_lookup",
      satsrail_status: httpStatus === null ? "transport" : String(httpStatus),
    },
    extra: { productId, satsrailApiUrl: apiUrl },
  });

  // These strings reach the buyer's browser, so they stay customer-safe: the
  // URL, the status and the underlying error go to the log line and the
  // Sentry event above, which is where an operator diagnoses this.
  if (httpStatus === null) {
    return NextResponse.json(
      { error: "Could not reach the payment service. Please try again shortly." },
      { status: 503 }
    );
  }

  if (httpStatus === 404) {
    return NextResponse.json(
      { error: "Product not found on SatsRail" },
      { status: 404 }
    );
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return NextResponse.json(
      { error: "The payment service rejected this store's credentials." },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { error: "The payment service returned an error. Please try again shortly." },
    { status: 502 }
  );
}

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
    let product: Awaited<ReturnType<typeof satsrail.getProduct>>;
    try {
      product = await satsrail.getProduct(sk, product_id);
    } catch (err) {
      return satsrailLookupFailure(err, product_id);
    }

    if (product.status !== "active") {
      return NextResponse.json(
        { error: "Product is not available for purchase" },
        { status: 400 }
      );
    }
    const productSlug = product.slug;

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
