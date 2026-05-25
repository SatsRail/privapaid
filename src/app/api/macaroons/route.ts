import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import {
  parseMacaroonCookie,
  serializeMacaroonCookie,
  insertWithCap,
  getMacaroon,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  MAX_BYTES,
} from "@/lib/macaroon-cookie";
import { verifySatsrailToken } from "@/lib/access-gate";
import { rateLimit } from "@/lib/rate-limit";
import { checkOrigin } from "@/lib/csrf";

function macaroonCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

/**
 * GET /api/macaroons — List product IDs the user has stored macaroons for.
 * Returns ONLY the IDs (never the macaroon strings). Used by a future
 * "Forget access" UI so users can manage their own stored entries.
 */
export async function GET() {
  const cookieStore = await cookies();
  const map = parseMacaroonCookie(cookieStore.get(COOKIE_NAME)?.value);
  const products = Object.entries(map)
    .filter(([, entry]) => !!entry?.m)
    .map(([product_id, entry]) => ({ product_id, stored_at: entry.t }))
    .sort((a, b) => b.stored_at - a.stored_at);
  return NextResponse.json({ products });
}

/**
 * POST /api/macaroons — Store a macaroon for a product
 * Body: { product_id, macaroon }
 */
export async function POST(req: NextRequest) {
  const csrf = checkOrigin(req);
  if (csrf) return csrf;
  const rl = await rateLimit("macaroon_write", 30);
  if (rl) return rl;

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

  let next;
  try {
    next = insertWithCap(existing, product_id, macaroon, Date.now());
  } catch (err) {
    if (err instanceof Error && err.message === "MACAROON_TOO_LARGE") {
      Sentry.captureMessage("macaroons.POST: single entry exceeds cap", {
        level: "error",
        tags: { context: "macaroons.POST", outcome: "413" },
        extra: { product_id, macaroonLength: macaroon.length },
      });
      return NextResponse.json(
        { error: "Macaroon is too large to store" },
        { status: 413 }
      );
    }
    throw err;
  }

  const cookieValueLength = serializeMacaroonCookie(next.map).length;
  // Promote to "warning" when we had to evict — that means we're operating
  // close to the cookie size cap, which is a leading indicator of users
  // running out of room. With Sentry dashboards filterable by level, a
  // sudden spike of warnings here would alert us to either raise MAX_BYTES
  // or shrink the per-macaroon size (the latter requires portal changes).
  Sentry.captureMessage("macaroons.POST: stored", {
    level: next.evicted > 0 ? "warning" : "info",
    tags: {
      context: "macaroons.POST",
      // `evictedAny` makes Sentry filtering trivial: tag:macaroons.POST evictedAny:true
      evictedAny: String(next.evicted > 0),
    },
    extra: {
      product_id,
      macaroonLength: macaroon.length,
      cookieValueLength,
      cookieBudgetUsedPct: Math.round((cookieValueLength / MAX_BYTES) * 100),
      existingProductsCount: Object.keys(next.map).length,
      isNewProduct: wasNewProduct,
      evicted: next.evicted,
      cookieSecure: process.env.NODE_ENV === "production",
    },
  });

  const response = NextResponse.json({ stored: true, evicted: next.evicted });
  response.cookies.set(
    COOKIE_NAME,
    serializeMacaroonCookie(next.map),
    macaroonCookieOptions()
  );
  return response;
}

/**
 * DELETE /api/macaroons — Remove a macaroon for a product
 * Body: { product_id }
 */
export async function DELETE(req: NextRequest) {
  const csrf = checkOrigin(req);
  if (csrf) return csrf;
  const rl = await rateLimit("macaroon_write", 30);
  if (rl) return rl;

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
    response.cookies.set(
      COOKIE_NAME,
      serializeMacaroonCookie(existing),
      macaroonCookieOptions()
    );
  }
  return response;
}

/**
 * PUT /api/macaroons — Verify a macaroon via SatsRail (server-side proxy)
 * Body: { product_id }
 * Returns the SatsRail verify response (key, remaining_seconds, etc.)
 */
export async function PUT(req: NextRequest) {
  const csrf = checkOrigin(req);
  if (csrf) return csrf;
  const rl = await rateLimit("macaroon_verify", 60);
  if (rl) return rl;

  const { product_id } = await req.json();
  if (!product_id) {
    return NextResponse.json({ error: "product_id required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(COOKIE_NAME)?.value;
  const macaroons = parseMacaroonCookie(rawCookie);
  const macaroon = getMacaroon(rawCookie, product_id);

  if (!macaroon) {
    // Promote to "error" when the cookie EXISTS and has OTHER products but
    // not the one we just asked for. That's the exact symptom of Chrome
    // dropping a Set-Cookie that pushed the value over its 4096-byte cap
    // (or our own LRU evicting the wrong entry — defense in depth tells
    // us if either failure mode shows up). A plain "cookie missing"
    // (fresh visitor) stays at "warning" — that's expected behavior.
    const hasOtherProducts = Object.keys(macaroons).length > 0;
    Sentry.captureMessage("macaroons.PUT: no entry for product", {
      level: hasOtherProducts ? "error" : "warning",
      tags: {
        context: "macaroons.PUT",
        outcome: hasOtherProducts ? "404_cookie_present_entry_missing" : "404",
      },
      extra: {
        product_id,
        cookiePresent: !!rawCookie,
        cookieValueLength: rawCookie?.length ?? 0,
        otherProductsInCookie: Object.keys(macaroons),
        // If this number stays well under MAX_BYTES, we know it's NOT a
        // size-cap issue and have to look elsewhere (e.g. concurrent
        // overwrite, SameSite, browser quirk).
        cookieBudgetUsedPct: rawCookie
          ? Math.round((rawCookie.length / MAX_BYTES) * 100)
          : 0,
      },
    });
    if (product_id in macaroons) {
      delete macaroons[product_id];
      const response = NextResponse.json({ error: "No macaroon found" }, { status: 404 });
      if (Object.keys(macaroons).length === 0) {
        response.cookies.delete(COOKIE_NAME);
      } else {
        response.cookies.set(
          COOKIE_NAME,
          serializeMacaroonCookie(macaroons),
          macaroonCookieOptions()
        );
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
    // Portal rejected the macaroon (HTTP 402). Historically we cleared the
    // cookie here, but a single transient rejection (portal hiccup, signing
    // key drift, key rotation race) would lock the user out for the rest of
    // the cookie's lifetime — even when they'd just paid. We now leave the
    // cookie alone and let it live to its natural expiry. The client treats
    // 410 as "no access right now," and a refresh re-attempts verification.
    Sentry.captureMessage("macaroons.PUT: portal rejected (cookie preserved)", {
      level: "error",
      tags: { context: "macaroons.PUT", outcome: "410_portal_rejected" },
      extra: {
        product_id,
        macaroonLength: macaroon.length,
        macaroonPrefix: macaroon.slice(0, 24),
        otherProductsInCookie: Object.keys(macaroons).filter((k) => k !== product_id),
      },
    });
    return NextResponse.json({ error: "Access expired" }, { status: 410 });
  }

  Sentry.captureMessage("macaroons.PUT: transient portal failure", {
    level: "warning",
    tags: { context: "macaroons.PUT", outcome: "502_transient" },
    extra: { product_id, reason: result.reason, httpStatus: result.httpStatus },
  });
  return NextResponse.json({ error: "Verification temporarily unavailable" }, { status: 502 });
}
