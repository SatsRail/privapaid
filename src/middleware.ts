import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// Owner-only routes (managers cannot access these)
const OWNER_ONLY_PATTERNS = [
  /^\/admin\/?$/, // dashboard
  /^\/admin\/admins/,
  /^\/admin\/categories/,
  /^\/admin\/settings/,
  /^\/api\/admin\/admins/,
  /^\/api\/admin\/categories/,
  /^\/api\/admin\/settings/,
];

function isOwnerOnly(pathname: string): boolean {
  return OWNER_ONLY_PATTERNS.some((p) => p.test(pathname));
}

function isSetupRoute(pathname: string): boolean {
  return pathname === "/setup" || pathname.startsWith("/api/setup");
}

// Inline scripts are nonce-gated in production. 'unsafe-inline'/'unsafe-eval'
// are only emitted in development, where Next's HMR and React Refresh require
// them — a nonce and 'unsafe-inline' are mutually exclusive (a present nonce
// makes browsers ignore 'unsafe-inline'), so prod uses the nonce and drops it.
// Next.js reads the nonce from the request CSP header and applies it to its own
// framework scripts and <Script> components automatically.
function buildCsp(nonce: string): string {
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com"
      : `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "frame-src 'self' https://satsrail.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com https://player.twitch.tv https://*.mediadelivery.net https://*.bunnycdn.com https://*.b-cdn.net https://stream.mux.com https://*.cloudflarestream.com https://videodelivery.net https://player.live-video.net",
    "connect-src 'self' https://satsrail.com https://www.google-analytics.com https://www.googletagmanager.com https://*.sentry.io",
  ].join("; ");
}

function handleAdminPages(pathname: string, token: { type?: string; role?: string } | null, url: string): NextResponse | null {
  if (!pathname.startsWith("/admin")) return null;

  if (!token || token.type !== "admin") {
    const loginUrl = new URL("/login", url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isOwnerOnly(pathname) && token.role !== "owner") {
    return NextResponse.redirect(new URL("/admin/channels", url));
  }

  return null;
}

function handleAdminApi(pathname: string, token: { type?: string; role?: string } | null): NextResponse | null {
  if (!pathname.startsWith("/api/admin")) return null;

  if (!token || token.type !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isOwnerOnly(pathname) && token.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const nonce = crypto.randomUUID();
  const csp = buildCsp(nonce);

  // Forward the nonce + CSP on the request so Next can nonce its own scripts
  // and server components can read `x-nonce` for any inline <script> they emit.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  let authResponse: NextResponse | null = null;
  if (
    (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) &&
    !isSetupRoute(pathname)
  ) {
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    const secureCookie = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;
    const token = await getToken({ req, secret: secret || undefined, secureCookie });

    authResponse =
      handleAdminPages(pathname, token, req.url) || handleAdminApi(pathname, token);
  }

  const response =
    authResponse ?? NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Run on every route except Next internals and static assets, so the
  // per-request CSP/nonce is applied site-wide. Admin/API authorization is
  // gated by pathname inside middleware(), so matching /api here is intentional.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
