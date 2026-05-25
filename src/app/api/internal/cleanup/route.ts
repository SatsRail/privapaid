import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Cron-triggered cleanup. Deletes audit logs older than 90 days and webhook
 * events older than 7 days. Replaces MongoDB TTL indexes that no longer exist
 * on the Postgres side.
 *
 * Auth: requires `Authorization: Bearer <CLEANUP_SECRET>` header. Set
 * CLEANUP_SECRET in env. The cron platform (Vercel, Railway, etc.) provides
 * the secret on each invocation.
 *
 * Schedule daily at ~03:00 UTC.
 */
export async function POST(req: Request) {
  const expected = process.env.CLEANUP_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "Cleanup secret not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const auditCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const webhookCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [auditDeleted, webhookDeleted] = await Promise.all([
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
    prisma.webhookEvent.deleteMany({ where: { processedAt: { lt: webhookCutoff } } }),
  ]);

  return NextResponse.json({
    auditLogsDeleted: auditDeleted.count,
    webhookEventsDeleted: webhookDeleted.count,
  });
}
