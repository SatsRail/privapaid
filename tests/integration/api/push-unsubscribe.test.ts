import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));

import { POST } from "@/app/api/push/unsubscribe/route";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/endpoint-1";

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/push/unsubscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedSub(channelId: string, endpoint: string) {
  return prisma.pushSubscription.create({
    data: { channelId, endpoint, p256dh: "p", auth: "a" },
  });
}

describe("POST /api/push/unsubscribe", () => {
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
  });

  it("deletes the matching row by endpoint + channel_slug", async () => {
    const ch = await createChannel({ slug: "ch-a" });
    await seedSub(ch.id, ENDPOINT);

    const res = await POST(postRequest({ endpoint: ENDPOINT, channel_slug: "ch-a" }));
    expect(res.status).toBe(200);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it("is idempotent — deleting a non-existent row still returns 200", async () => {
    const res = await POST(postRequest({ endpoint: ENDPOINT }));
    expect(res.status).toBe(200);
  });

  it("with channel_slug, removes only that channel's row for the endpoint", async () => {
    const a = await createChannel({ slug: "keep-a" });
    const b = await createChannel({ slug: "keep-b" });
    await seedSub(a.id, ENDPOINT);
    await seedSub(b.id, ENDPOINT);

    const res = await POST(postRequest({ endpoint: ENDPOINT, channel_slug: "keep-a" }));
    expect(res.status).toBe(200);

    const remaining = await prisma.pushSubscription.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].channelId).toBe(b.id);
  });

  it("without channel_slug, removes every row for the endpoint", async () => {
    const a = await createChannel({ slug: "all-a" });
    const b = await createChannel({ slug: "all-b" });
    await seedSub(a.id, ENDPOINT);
    await seedSub(b.id, ENDPOINT);

    const res = await POST(postRequest({ endpoint: ENDPOINT }));
    expect(res.status).toBe(200);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it("400 when the endpoint is missing", async () => {
    const res = await POST(postRequest({ channel_slug: "x" }));
    expect(res.status).toBe(400);
  });
});
