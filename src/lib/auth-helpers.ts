import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

interface AdminSession {
  id: string;
  email: string;
  name: string;
  role: string;
  type: "admin";
}

/**
 * Get the current session or null. Wrapper around NextAuth's auth().
 */
export async function getSessionOrNull() {
  return auth();
}

/**
 * Require an admin session for server components. Redirects to login if not authenticated.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await auth();
  if (!session?.user || session.user.type !== "admin") {
    redirect("/login");
  }
  return {
    id: session.user.id,
    email: session.user.email || "",
    name: session.user.name || "",
    role: session.user.role || "admin",
    type: "admin",
  };
}

/**
 * Require an owner session. Redirects to /admin if not owner.
 */
export async function requireOwner(): Promise<AdminSession> {
  const admin = await requireAdmin();
  if (admin.role !== "owner") {
    redirect("/admin/channels");
  }
  return admin;
}

/**
 * Require an admin session for API routes. Returns 401 JSON if not authenticated.
 */
export async function requireAdminApi(): Promise<AdminSession | NextResponse> {
  const session = await auth();
  if (!session?.user || session.user.type !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return {
    id: session.user.id,
    email: session.user.email || "",
    name: session.user.name || "",
    role: session.user.role || "admin",
    type: "admin",
  };
}

/**
 * Require an owner session for API routes. Returns 403 JSON if not owner.
 */
export async function requireOwnerApi(): Promise<
  AdminSession | NextResponse
> {
  const result = await requireAdminApi();
  if (result instanceof NextResponse) return result;
  if (result.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return result;
}
