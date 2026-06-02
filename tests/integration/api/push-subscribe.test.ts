import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mocks — MUST be before the route import.
const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));

const { mockConfig } = vi.hoisted(() => ({ mockConfig: { nsfw: false } }));
vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn(async () => ({
    name: "Test Instance",
    domain: "test.example.com",
    nsfw: mockConfig.nsfw,
    theme: { primary: "#000000", bg: "#000000" },
  })),
}));

import { POST } from "@/app/api/push/subscribe/route";

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "p256dh-key-value", auth: "auth-key-value" },
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/push/subscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/push/subscribe", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue(null);
    mockConfig.nsfw = false;
  });

  it("creates a subscription row (201)", async () => {
    const ch = await createChannel({ slug: "notify-me" });
    const res = await POST(postRequest({ channel_slug: "notify-me", subscription: SUB }));
    expect(res.status).toBe(201);

    const rows = await prisma.pushSubscription.findMany({ where: { channelId: ch.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(SUB.endpoint);
    expect(rows[0].p256dh).toBe("p256dh-key-value");
    expect(rows[0].auth).toBe("auth-key-value");
  });

  it("upserts on repeat subscribe — no duplicate, refreshes keys + lastSeenAt", async () => {
    const ch = await createChannel({ slug: "again" });
    await POST(postRequest({ channel_slug: "again", subscription: SUB }));
    const first = await prisma.pushSubscription.findFirstOrThrow({ where: { channelId: ch.id } });

    const updated = { endpoint: SUB.endpoint, keys: { p256dh: "new-p256", auth: "new-auth" } };
    const res = await POST(postRequest({ channel_slug: "again", subscription: updated }));
    expect(res.status).toBe(201);

    const rows = await prisma.pushSubscription.findMany({ where: { channelId: ch.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe("new-p256");
    expect(rows[0].auth).toBe("new-auth");
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it("404 for an unknown channel slug", async () => {
    const res = await POST(postRequest({ channel_slug: "ghost", subscription: SUB }));
    expect(res.status).toBe(404);
  });

  it("404 for an inactive channel", async () => {
    await createChannel({ slug: "off", active: false });
    const res = await POST(postRequest({ channel_slug: "off", subscription: SUB }));
    expect(res.status).toBe(404);
  });

  it("404 for a soft-deleted channel", async () => {
    const ch = await createChannel({ slug: "gone" });
    await prisma.channel.update({ where: { id: ch.id }, data: { deletedAt: new Date() } });
    const res = await POST(postRequest({ channel_slug: "gone", subscription: SUB }));
    expect(res.status).toBe(404);
  });

  it("404 for an NSFW channel when instance NSFW is disabled", async () => {
    mockConfig.nsfw = false;
    await createChannel({ slug: "adult", nsfw: true });
    const res = await POST(postRequest({ channel_slug: "adult", subscription: SUB }));
    expect(res.status).toBe(404);
  });

  it("201 for an NSFW channel when instance NSFW is enabled", async () => {
    mockConfig.nsfw = true;
    await createChannel({ slug: "adult-ok", nsfw: true });
    const res = await POST(postRequest({ channel_slug: "adult-ok", subscription: SUB }));
    expect(res.status).toBe(201);
  });

  it("400 when the subscription is missing", async () => {
    await createChannel({ slug: "bad" });
    const res = await POST(postRequest({ channel_slug: "bad" }));
    expect(res.status).toBe(400);
  });

  it("400 when the endpoint is not a URL", async () => {
    await createChannel({ slug: "badurl" });
    const res = await POST(
      postRequest({
        channel_slug: "badurl",
        subscription: { endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } },
      })
    );
    expect(res.status).toBe(400);
  });

  it("propagates a 429 from the rate limiter", async () => {
    mockRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })
    );
    const res = await POST(postRequest({ channel_slug: "anything", subscription: SUB }));
    expect(res.status).toBe(429);
  });
});
