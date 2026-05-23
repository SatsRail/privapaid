import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { parseMacaroonCookie, COOKIE_NAME, COOKIE_MAX_AGE } from "@/lib/macaroon-cookie";
import { verifySatsrailToken } from "@/lib/access-gate";

/**
 * POST /api/macaroons — Store a macaroon for a product
 * Body: { product_id, macaroon }
 */
export async function POST(req: NextRequest) {
  const { product_id, macaroon } = await req.json();
  if (!product_id || !macaroon) {
    Sentry.captureMessage("macaroons.POST: missing field", {
      level: "error",
      tags: { context: "macaroons.POST" },
      extra: { hasProductId: !!product_id, hasMacaroon: !!macaroon },
    });
    return NextResponse.json({ error: "product_id and macaroon required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const existing = parseMacaroonCookie(cookieStore.get(COOKIE_NAME)?.value);
  const wasNewProduct = !(product_id in existing);
  existing[product_id] = macaroon;

  // Every store attempt produces a server-side event so we can correlate:
  // "did POST actually run for this product?" vs. "did the browser drop the
  // cookie?" If POST runs but the next request shows no cookie, the browser
  // is rejecting the Set-Cookie — a config issue (SameSite, Secure, size).
  Sentry.captureMessage("macaroons.POST: stored", {
    level: "info",
    tags: { context: "macaroons.POST" },
    extra: {
      product_id,
      macaroonLength: macaroon.length,
      cookieValueLength: JSON.stringify(existing).length,
      existingProductsCount: Object.keys(existing).length,
      isNewProduct: wasNewProduct,
      cookieSecure: process.env.NODE_ENV === "production",
    },
  });

  const response = NextResponse.json({ stored: true });
  response.cookies.set(COOKIE_NAME, JSON.stringify(existing), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return response;
}

/**
 * DELETE /api/macaroons — Remove a macaroon for a product
 * Body: { product_id }
 */
export async function DELETE(req: NextRequest) {
  const { product_id } = await req.json();
  if (!product_id) {
    return NextResponse.json({ error: "product_id required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const existing = parseMacaroonCookie(cookieStore.get(COOKIE_NAME)?.value);
  delete existing[product_id];

  const response = NextResponse.json({ removed: true });
  if (Object.keys(existing).length === 0) {
    response.cookies.delete(COOKIE_NAME);
  } else {
    response.cookies.set(COOKIE_NAME, JSON.stringify(existing), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }
  return response;
}

/**
 * PUT /api/macaroons — Verify a macaroon via SatsRail (server-side proxy)
 * Body: { product_id }
 * Returns the SatsRail verify response (key, remaining_seconds, etc.)
 */
export async function PUT(req: NextRequest) {
  const { product_id } = await req.json();
  if (!product_id) {
    return NextResponse.json({ error: "product_id required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(COOKIE_NAME)?.value;
  const macaroons = parseMacaroonCookie(rawCookie);
  const macaroon = macaroons[product_id];

  if (!macaroon) {
    // No entry for this product in the cookie. This is the most common
    // mystery state — "user paid, refreshed, lost access". Capture richly
    // so we can tell whether the cookie itself is missing or just lacks
    // an entry for THIS product.
    Sentry.captureMessage("macaroons.PUT: no entry for product", {
      level: "warning",
      tags: { context: "macaroons.PUT", outcome: "404" },
      extra: {
        product_id,
        cookiePresent: !!rawCookie,
        cookieValueLength: rawCookie?.length ?? 0,
        otherProductsInCookie: Object.keys(macaroons),
      },
    });
    // Clean up empty/falsy entries left by previous bugs
    if (product_id in macaroons) {
      delete macaroons[product_id];
      const response = NextResponse.json({ error: "No macaroon found" }, { status: 404 });
      if (Object.keys(macaroons).length === 0) {
        response.cookies.delete(COOKIE_NAME);
      } else {
        response.cookies.set(COOKIE_NAME, JSON.stringify(macaroons), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: COOKIE_MAX_AGE,
        });
      }
      return response;
    }
    return NextResponse.json({ error: "No macaroon found" }, { status: 404 });
  }

  const result = await verifySatsrailToken(macaroon);

  if (result.status === "valid") {
    return NextResponse.json({
      key: result.key,
      key_fingerprint: result.keyFingerprint,
      remaining_seconds: result.remainingSeconds,
    });
  }

  if (result.status === "invalid") {
    // Portal definitively rejected the macaroon (HTTP 402) — it is either
    // expired or signature-invalid. Safe to clear it from the cookie.
    // This is the SMOKING GUN if the customer just paid: it means the
    // portal won't accept a macaroon it just minted. Capture richly.
    Sentry.captureMessage("macaroons.PUT: portal rejected (clearing cookie)", {
      level: "error",
      tags: { context: "macaroons.PUT", outcome: "410_portal_rejected" },
      extra: {
        product_id,
        macaroonLength: macaroon.length,
        macaroonPrefix: macaroon.slice(0, 24),
        otherProductsInCookie: Object.keys(macaroons).filter((k) => k !== product_id),
      },
    });
    delete macaroons[product_id];
    const response = NextResponse.json({ error: "Access expired" }, { status: 410 });
    if (Object.keys(macaroons).length === 0) {
      response.cookies.delete(COOKIE_NAME);
    } else {
      response.cookies.set(COOKIE_NAME, JSON.stringify(macaroons), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
      });
    }
    return response;
  }

  // status: "transient" — portal blip, network error, or surprising body.
  // Do NOT delete the cookie. The macaroon may still be valid; let the
  // client retry on next page load or heartbeat.
  Sentry.captureMessage("macaroons.PUT: transient portal failure", {
    level: "warning",
    tags: { context: "macaroons.PUT", outcome: "502_transient" },
    extra: { product_id, reason: result.reason, httpStatus: result.httpStatus },
  });
  return NextResponse.json({ error: "Verification temporarily unavailable" }, { status: 502 });
}
