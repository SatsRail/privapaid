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

  if (isSetupRoute(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  const secureCookie = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;
  const token = await getToken({ req, secret: secret || undefined, secureCookie });

  return (
    handleAdminPages(pathname, token, req.url) ||
    handleAdminApi(pathname, token) ||
    NextResponse.next()
  );
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
    "/setup",
    "/api/setup/:path*",
  ],
};
