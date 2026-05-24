import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight CSRF check based on the `Origin` (or `Referer`) header.
 *
 * SameSite=Lax on the `satsrail_macaroons` cookie already blocks the
 * common cross-site POST scenarios in modern browsers — this is
 * defense-in-depth for:
 *   - Older browser quirks
 *   - Reverse-proxy setups that surface a Set-Cookie domain mismatch
 *   - Non-browser callers (curl, scripts) trying to leverage a
 *     compromised cookie they somehow obtained
 *
 * Behavior:
 *   - If `Origin` is present, it must match the request host (`Host` header).
 *   - If `Origin` is absent but `Referer` is present, its origin must match.
 *   - If both are absent, we ALLOW the request — many non-browser clients
 *     (server-to-server, internal tooling) intentionally omit these
 *     headers, and rejecting them would break legitimate flows. The
 *     attacker we're worried about here is a browser tricked into
 *     issuing a cross-origin POST, and browsers always send `Origin`
 *     on POST/DELETE/PUT.
 *
 * Returns a 403 NextResponse when the check fails, or null when allowed.
 */
export function checkOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");

  if (!host) {
    // No Host header means we can't compare. Allow — Next.js will have
    // its own defenses against missing Host, and we don't want to be
    // the source of a confusing 403 in an obscure dev setup.
    return null;
  }

  const expectedHost = host.toLowerCase();

  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost !== expectedHost) {
        return NextResponse.json(
          { error: "Origin mismatch" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid Origin" }, { status: 403 });
    }
    return null;
  }

  if (referer) {
    try {
      const refererHost = new URL(referer).host.toLowerCase();
      if (refererHost !== expectedHost) {
        return NextResponse.json(
          { error: "Referer mismatch" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json({ error: "Invalid Referer" }, { status: 403 });
    }
    return null;
  }

  // Neither Origin nor Referer present — pass through (see Behavior note).
  return null;
}
