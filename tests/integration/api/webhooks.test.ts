import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

// Import the route handler
import { POST } from "@/app/api/webhooks/satsrail/route";

const WEBHOOK_SECRET = process.env.SATSRAIL_WEBHOOK_SECRET!;

function signPayload(payload: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

function createWebhookRequest(
  body: string,
  options: { signature?: string; timestamp?: string } = {}
): NextRequest {
  const signature = options.signature ?? signPayload(body);
  const timestamp =
    options.timestamp ?? String(Math.floor(Date.now() / 1000));

  return new NextRequest(new URL("http://localhost:3000/api/webhooks/satsrail"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-satsrail-signature": signature,
      "x-satsrail-timestamp": timestamp,
    },
    body,
  });
}

describe("POST /api/webhooks/satsrail", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("processes a valid webhook event", async () => {
    const payload = JSON.stringify({
      id: "evt_test_1",
      type: "product.key_rotated",
      payload: { product_id: "prod_123" },
    });
    const req = createWebhookRequest(payload);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);

    // Verify event was recorded
    const event = await prisma.webhookEvent.findFirst({ where: { eventId: "evt_test_1" } });
    expect(event).toBeTruthy();
    expect(event!.eventType).toBe("product.key_rotated");
  });

  it("returns 401 for invalid signature", async () => {
    const payload = JSON.stringify({
      id: "evt_test_2",
      type: "test.event",
      payload: {},
    });
    const req = createWebhookRequest(payload, { signature: "invalidsig" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
  });

  it("returns 400 for expired timestamp", async () => {
    const payload = JSON.stringify({
      id: "evt_test_3",
      type: "test.event",
      payload: {},
    });
    // Timestamp 10 minutes ago (beyond 5 min tolerance)
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const req = createWebhookRequest(payload, { timestamp: oldTimestamp });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Timestamp out of tolerance");
  });

  it("skips duplicate events (idempotency)", async () => {
    const payload = JSON.stringify({
      id: "evt_duplicate",
      type: "merchant.plan_changed",
      payload: { plan: "pro" },
    });

    // Process first time
    const req1 = createWebhookRequest(payload);
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    // Process second time — should be flagged as duplicate
    const req2 = createWebhookRequest(payload);
    const res2 = await POST(req2);
    const body2 = await res2.json();
    expect(body2.received).toBe(true);
    expect(body2.duplicate).toBe(true);

    // Only one event recorded
    const count = await prisma.webhookEvent.count({ where: { eventId: "evt_duplicate" } });
    expect(count).toBe(1);
  });

  it("handles events without id", async () => {
    const payload = JSON.stringify({
      type: "merchant.suspended",
      payload: { merchant_id: "merch_123" },
    });
    const req = createWebhookRequest(payload);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
  });

  it("concurrent identical deliveries produce exactly one DB row", async () => {
    const payload = JSON.stringify({
      id: "evt_race",
      type: "merchant.plan_changed",
      payload: {},
    });

    const [r1, r2] = await Promise.all([
      POST(createWebhookRequest(payload)),
      POST(createWebhookRequest(payload)),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    // Exactly one of them should be the duplicate ack.
    const duplicates = [b1, b2].filter((b) => b.duplicate === true);
    expect(duplicates).toHaveLength(1);

    // Only one row in the table.
    const count = await prisma.webhookEvent.count({ where: { eventId: "evt_race" } });
    expect(count).toBe(1);
  });

  it("handles unknown event types gracefully", async () => {
    const payload = JSON.stringify({
      id: "evt_unknown",
      type: "unknown.event",
      payload: {},
    });
    const req = createWebhookRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });
});
