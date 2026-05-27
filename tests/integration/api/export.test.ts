import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct } from "../../helpers/factories";
import { createCategory, createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mock auth
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
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

import { GET } from "@/app/api/admin/export/route";

describe("GET /api/admin/export", () => {
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
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("exports empty content when no data exists", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body.version).toBe("1.0");
    expect(body.exported_at).toBeDefined();
    expect(body.categories).toEqual([]);
    expect(body.channels).toEqual([]);
  });

  it("exports categories with slug, name, position, active", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    await createCategory({ name: "Movies", slug: "movies", position: 1, active: true });
    await createCategory({ name: "Music", slug: "music", position: 2, active: false });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.categories).toHaveLength(2);
    expect(body.categories[0]).toMatchObject({
      slug: "movies",
      name: "Movies",
      position: 1,
      active: true,
    });
    expect(body.categories[1]).toMatchObject({
      slug: "music",
      name: "Music",
      position: 2,
      active: false,
    });
  });

  it("exports channels with nested media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const category = await createCategory({ name: "Education", slug: "education" });
    const channel = await createChannel({
      name: "Bitcoin 101",
      slug: "bitcoin-101",
      bio: "Learn Bitcoin",
      categoryId: category.id,
      nsfw: false,
    });
    await createMedia(channel.id, {
      name: "Episode 1",
      blob: { kind: "url", url: "https://example.com/ep1.mp4" },
      mediaType: "video",
      position: 1,
    });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      slug: "bitcoin-101",
      name: "Bitcoin 101",
      bio: "Learn Bitcoin",
    });
    expect(body.channels[0].ref).toBeDefined();
    expect(body.channels[0].media).toHaveLength(1);
    expect(body.channels[0].media[0]).toMatchObject({
      name: "Episode 1",
      source_url: "https://example.com/ep1.mp4",
      media_type: "video",
    });
    expect(body.channels[0].media[0].ref).toBeDefined();
  });

  it("exports media with product info from cached data", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ name: "Test", slug: "test-ch" });
    const media = await createMedia(channel.id, {
      name: "Paid Video",
      blob: { kind: "url", url: "https://example.com/paid.mp4" },
    });

    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_123",
        encryptedSource: "encrypted-blob",
        keyFingerprint: "abc123",
        productName: "Paid Video Access",
        productPriceCents: 500,
        productCurrency: "USD",
        productAccessDurationSeconds: 86400,
        productExternalRef: "md_custom_99",
      });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.channels[0].media[0].product).toMatchObject({
      name: "Paid Video Access",
      price_cents: 500,
      currency: "USD",
      access_duration_seconds: 86400,
      external_ref: "md_custom_99",
    });
  });

  it("exports product external_ref derived from media ref when no cached value", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ name: "Legacy", slug: "legacy-ch" });
    const media = await createMedia(channel.id, {
      name: "Legacy Video",
      blob: { kind: "url", url: "https://example.com/legacy.mp4" },
    });

    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_legacy",
        encryptedSource: "encrypted-blob",
        keyFingerprint: "fp",
        productName: "Legacy Access",
        productPriceCents: 100,
        productCurrency: "USD",
        // Note: no productExternalRef — simulating legacy data
      });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.channels[0].media[0].product.external_ref).toBe(`md_${media.ref}`);
  });

  it("exports channel product external_ref derived from channel ref when no cached value", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ name: "Bundle", slug: "bundle-ch" });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_bundle",
        keyFingerprint: "fp_bundle",
        productName: "Bundle Access",
        productPriceCents: 1000,
        productCurrency: "USD",
      });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.channels[0].product.external_ref).toBe(`ch_${channel.ref}`);
  });

  it("sets Content-Disposition header for file download", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const res = await GET();
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toMatch(/^attachment; filename="privapaid-export-\d{4}-\d{2}-\d{2}\.json"$/);
  });

  it("uses null category_slug when channel has no categoryId", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    await createChannel({ name: "Lone", slug: "lone-ch" });
    const res = await GET();
    const body = JSON.parse(await res.text());
    expect(body.channels[0].category_slug).toBeNull();
  });

  it("applies default currency and zero price when ChannelProduct lacks them", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Defaults", slug: "defaults-ch" });

    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_def",
        keyFingerprint: "fp_def",
        productName: "With Defaults",
      });

    const res = await GET();
    const body = JSON.parse(await res.text());
    expect(body.channels[0].product.price_cents).toBe(0);
    expect(body.channels[0].product.currency).toBe("USD");
  });

  it("omits product when ChannelProduct has no productName", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "Nameless", slug: "nameless-ch" });
    await createChannelProduct({
        channelId: channel.id,
        satsrailProductId: "prod_nameless",
        keyFingerprint: "fp_nameless",
      });

    const res = await GET();
    const body = JSON.parse(await res.text());
    expect(body.channels[0].product).toBeUndefined();
  });

  it("omits product when MediaProduct has no productName", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const channel = await createChannel({ name: "NoNameMp", slug: "no-name-mp" });
    const media = await createMedia(channel.id, {
      name: "Plain",
      blob: { kind: "url", url: "https://example.com/plain.mp4" },
    });
    await createMediaProduct({
        mediaId: media.id,
        satsrailProductId: "prod_blank",
        encryptedSource: "blob",
        keyFingerprint: "fp",
      });
    const res = await GET();
    const body = JSON.parse(await res.text());
    expect(body.channels[0].media[0].product).toBeUndefined();
  });

  it("excludes deleted channels and media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ name: "Active", slug: "active-ch" });
    const deletedChannel = await createChannel({ name: "Deleted", slug: "deleted-ch" });
    await prisma.channel.update({ where: { id: deletedChannel.id }, data: { deletedAt: new Date() } });
    await createMedia(channel.id, { name: "Active Media" });
    const sd = await createMedia(channel.id, { name: "Deleted Media" });
    await prisma.media.update({ where: { id: sd.id }, data: { deletedAt: new Date() } });

    const res = await GET();
    const body = JSON.parse(await res.text());

    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].slug).toBe("active-ch");
    expect(body.channels[0].media).toHaveLength(1);
    expect(body.channels[0].media[0].name).toBe("Active Media");
  });
});
