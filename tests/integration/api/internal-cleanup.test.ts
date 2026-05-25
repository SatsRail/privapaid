import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { POST } from "@/app/api/internal/cleanup/route";
import { prisma } from "@/lib/prisma";

function buildRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return new Request("http://localhost:3000/api/internal/cleanup", {
    method: "POST",
    headers,
  });
}

const originalSecret = process.env.CLEANUP_SECRET;

describe("POST /api/internal/cleanup", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
    process.env.CLEANUP_SECRET = originalSecret;
  });

  afterEach(async () => {
    await clearCollections();
    process.env.CLEANUP_SECRET = originalSecret;
  });

  it("returns 503 when CLEANUP_SECRET is not configured", async () => {
    delete process.env.CLEANUP_SECRET;
    const res = await POST(buildRequest("Bearer anything"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("returns 401 when authorization header is missing", async () => {
    process.env.CLEANUP_SECRET = "test-secret";
    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when authorization header doesn't match", async () => {
    process.env.CLEANUP_SECRET = "test-secret";
    const res = await POST(buildRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 200 and deletes old audit logs and webhook events", async () => {
    process.env.CLEANUP_SECRET = "test-secret";

    // Seed: 2 old audit logs (>90d), 1 recent; 2 old webhooks (>7d), 1 recent.
    const veryOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

    const old1 = await prisma.auditLog.create({
      data: { actorId: "a", actorType: "system", action: "x" },
    });
    const old2 = await prisma.auditLog.create({
      data: { actorId: "b", actorType: "system", action: "y" },
    });
    const newAudit = await prisma.auditLog.create({
      data: { actorId: "c", actorType: "system", action: "z" },
    });
    // Backdate the two "old" ones via raw SQL (Prisma blocks setting @default(now())).
    await prisma.$executeRaw`
      UPDATE "AuditLog" SET "createdAt" = ${veryOld.toISOString()}::timestamp
      WHERE id IN (${old1.id}, ${old2.id})
    `;

    const oldWh1 = await prisma.webhookEvent.create({
      data: { eventId: "evt-old-1", eventType: "x" },
    });
    const oldWh2 = await prisma.webhookEvent.create({
      data: { eventId: "evt-old-2", eventType: "x" },
    });
    const newWh = await prisma.webhookEvent.create({
      data: { eventId: "evt-new", eventType: "x" },
    });
    await prisma.$executeRaw`
      UPDATE "WebhookEvent" SET "processedAt" = ${veryOld.toISOString()}::timestamp
      WHERE id IN (${oldWh1.id}, ${oldWh2.id})
    `;
    void recent;

    const res = await POST(buildRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auditLogsDeleted).toBe(2);
    expect(body.webhookEventsDeleted).toBe(2);

    // Recent rows survive
    const remainingAudit = await prisma.auditLog.findMany({ select: { id: true } });
    expect(remainingAudit.map((r) => r.id)).toEqual([newAudit.id]);
    const remainingWh = await prisma.webhookEvent.findMany({ select: { id: true } });
    expect(remainingWh.map((r) => r.id)).toEqual([newWh.id]);
  });

  it("returns 200 with zero deletions when nothing is old enough", async () => {
    process.env.CLEANUP_SECRET = "test-secret";
    await prisma.auditLog.create({
      data: { actorId: "a", actorType: "system", action: "x" },
    });
    await prisma.webhookEvent.create({
      data: { eventId: "evt-1", eventType: "x" },
    });

    const res = await POST(buildRequest("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auditLogsDeleted).toBe(0);
    expect(body.webhookEventsDeleted).toBe(0);
  });
});
