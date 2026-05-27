import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mock auth
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// Mock satsrail client
vi.mock("@/lib/satsrail", () => ({
  satsrail: {},
}));

// Mock getMerchantKey
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

// Mock audit
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

// Mock next/headers for audit
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(""),
  }),
}));

import { GET } from "@/app/api/admin/channels/[id]/export/route";

function exportRequest(channelId: string): [Request, { params: Promise<{ id: string }> }] {
  const req = new Request(
    new URL(`http://localhost:3000/api/admin/channels/${channelId}/export`)
  );
  return [req, { params: Promise.resolve({ id: channelId }) }];
}

describe("GET /api/admin/channels/[id]/export", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const [req, ctx] = exportRequest("fake-id");
    const res = await GET(req, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent channel", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const fakeId = "ckmissingfakefakefakefake";
    const [req, ctx] = exportRequest(fakeId);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 for soft-deleted channel", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Deleted", slug: "deleted-ch" });
    await prisma.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } });
    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it("exports empty media array when channel has no media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Empty Channel", slug: "empty-ch" });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body.version).toBe("1.0");
    expect(body.media).toEqual([]);
  });

  it("exports media items with correct fields", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Test Channel", slug: "test-ch" });
    await createMedia(channel.id, {
      name: "Episode 1",
      description: "First episode",
      blob: { kind: "url", url: "https://example.com/ep1.mp4" },
      mediaType: "video",
      position: 1,
    });
    await createMedia(channel.id, {
      name: "Episode 2",
      blob: { kind: "url", url: "https://example.com/ep2.mp3" },
      mediaType: "audio",
      position: 2,
    });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.version).toBe("1.0");
    expect(body.media).toHaveLength(2);
    expect(body.media[0]).toMatchObject({
      name: "Episode 1",
      description: "First episode",
      source_url: "https://example.com/ep1.mp4",
      media_type: "video",
      position: 1,
    });
    expect(body.media[0].ref).toBeDefined();
    expect(body.media[1]).toMatchObject({
      name: "Episode 2",
      source_url: "https://example.com/ep2.mp3",
      media_type: "audio",
      position: 2,
    });
  });

  it("includes product info for media with MediaProduct", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Paid Channel", slug: "paid-ch" });
    const media = await createMedia(channel.id, {
      name: "Premium Video",
      blob: { kind: "url", url: "https://example.com/premium.mp4" },
    });

    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_123",
        encryptedSource: "encrypted-blob",
        keyFingerprint: "fp_abc",
        productName: "Premium Access",
        productPriceCents: 500,
        productCurrency: "USD",
        productAccessDurationSeconds: 86400,
      });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.media).toHaveLength(1);
    expect(body.media[0].product).toMatchObject({
      name: "Premium Access",
      price_cents: 500,
      currency: "USD",
      access_duration_seconds: 86400,
    });
  });

  it("does not include product for media without MediaProduct", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Free Channel", slug: "free-ch" });
    await createMedia(channel.id, {
      name: "Free Video",
      blob: { kind: "url", url: "https://example.com/free.mp4" },
    });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.media).toHaveLength(1);
    expect(body.media[0].product).toBeUndefined();
  });

  it("excludes soft-deleted media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Mix Channel", slug: "mix-ch" });
    await createMedia(channel.id, { name: "Active Media" });
    const sd = await createMedia(channel.id, { name: "Deleted Media" });
    await prisma.media.update({ where: { id: sd.id }, data: { deletedAt: new Date() } });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.media).toHaveLength(1);
    expect(body.media[0].name).toBe("Active Media");
  });

  it("sets Content-Disposition header with channel slug", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "My Channel", slug: "my-channel" });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toBe('attachment; filename="channel-my-channel-export.json"');
  });

  it("returns media sorted by position", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Sorted", slug: "sorted-ch" });
    await createMedia(channel.id, { name: "Third", position: 3 });
    await createMedia(channel.id, { name: "First", position: 1 });
    await createMedia(channel.id, { name: "Second", position: 2 });

    const [req, ctx] = exportRequest(channel.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.media).toHaveLength(3);
    expect(body.media[0].name).toBe("First");
    expect(body.media[1].name).toBe("Second");
    expect(body.media[2].name).toBe("Third");
  });

  it("only exports media belonging to the target channel", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel1 = await createChannel({ name: "Channel A", slug: "ch-a" });
    const channel2 = await createChannel({ name: "Channel B", slug: "ch-b" });
    await createMedia(channel1.id, { name: "Media A" });
    await createMedia(channel2.id, { name: "Media B" });

    const [req, ctx] = exportRequest(channel1.id);
    const res = await GET(req, ctx);
    const body = JSON.parse(await res.text());

    expect(body.media).toHaveLength(1);
    expect(body.media[0].name).toBe("Media A");
  });
});
