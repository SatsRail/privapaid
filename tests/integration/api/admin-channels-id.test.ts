import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct, countMediaProducts, countChannelProducts } from "../../helpers/factories";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock audit
const mockAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  audit: (...args: unknown[]) => mockAudit(...args),
}));

// Mock admin auth
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireOwnerApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireCustomerApi: vi.fn().mockResolvedValue({
    id: "customer-1",
    name: "testuser",
  }),
}));

// Mock SatsRail (channel DELETE archives products through it)
const mockDeleteProduct = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/satsrail", () => ({
  satsrail: {
    deleteProduct: (...args: unknown[]) => mockDeleteProduct(...args),
  },
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

import { GET, PATCH, DELETE } from "@/app/api/admin/channels/[id]/route";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

import { NextRequest } from "next/server";

function buildRequest(
  method: string,
  id: string,
  body?: unknown
): [NextRequest, { params: Promise<{ id: string }> }] {
  const url = new URL(`http://localhost:3000/api/admin/channels/${id}`);
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return [new NextRequest(url, init), { params: Promise.resolve({ id }) }];
}

describe("Admin Channels [id] routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    mockDeleteProduct.mockClear();
    mockAudit.mockClear();
  });

  describe("GET /api/admin/channels/:id", () => {
    it("returns channel by ID", async () => {
      const channel = await createChannel({ name: "Test Channel", slug: "test-ch" });
      const [req, ctx] = buildRequest("GET", channel.id);
      const res = await GET(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Test Channel");
      expect(body.data.slug).toBe("test-ch");
    });

    it("returns 404 for unknown ID", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const [req, ctx] = buildRequest("GET", fakeId);
      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    });
  });

  describe("PATCH /api/admin/channels/:id", () => {
    it("updates channel fields", async () => {
      const channel = await createChannel({ name: "Old", slug: "old-ch", bio: "old bio" });
      const [req, ctx] = buildRequest("PATCH", channel.id, {
        name: "Updated",
        bio: "new bio",
      });
      const res = await PATCH(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Updated");
      expect(body.data.bio).toBe("new bio");
    });

    it("rejects duplicate slug", async () => {
      await createChannel({ name: "Existing", slug: "existing-slug" });
      const target = await createChannel({ name: "Target", slug: "target-slug" });
      const [req, ctx] = buildRequest("PATCH", target.id, {
        slug: "existing-slug",
      });
      const res = await PATCH(req, ctx);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Slug already taken");
    });

    it("returns 404 for missing channel", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const [req, ctx] = buildRequest("PATCH", fakeId, { name: "Nope" });
      const res = await PATCH(req, ctx);

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/channels/:id", () => {
    it("hard-deletes a channel with no media", async () => {
      const channel = await createChannel({
        name: "Empty",
        slug: "empty-ch",
        active: true,
      });
      const [req, ctx] = buildRequest("DELETE", channel.id);
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.media_deleted).toBe(0);
      expect(body.archived_product_ids).toEqual([]);

      const found = await prisma.channel.findUnique({ where: { id: channel.id } });
      expect(found).toBeNull();

      // No products to archive — SatsRail must not be hit
      expect(mockDeleteProduct).not.toHaveBeenCalled();
    });

    it("cascades through media and archives all SatsRail products", async () => {
      const channel = await createChannel({ name: "Full", slug: "full-ch" });
      const channelId = channel.id;

      const m1 = await createMedia(channelId, {
        name: "Video 1",
        blob: { kind: "url", url: "https://example.com/1.mp4" },
      });
      const m2 = await createMedia(channelId, {
        name: "Video 2",
        blob: { kind: "url", url: "https://example.com/2.mp4" },
      });

      // Two media-level products + one channel-level product = 3 SatsRail archives
      await createMediaProduct({
          mediaId: m1.id,
          satsrailProductId: "prod_media_1",
          encryptedSourceUrl: "blob1",
        });
      await createMediaProduct({
          mediaId: m2.id,
          satsrailProductId: "prod_media_2",
          encryptedSourceUrl: "blob2",
        });
      await createChannelProduct({
          channelId: channel.id,
          satsrailProductId: "prod_channel_1",
          encryptedMedia: [
              { mediaId: m1.id, encryptedSourceUrl: "blob1" },
              { mediaId: m2.id, encryptedSourceUrl: "blob2" },
            ],
        });

      const [req, ctx] = buildRequest("DELETE", channelId);
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.media_deleted).toBe(2);
      expect(body.archived_product_ids).toEqual(
        expect.arrayContaining(["prod_media_1", "prod_media_2", "prod_channel_1"])
      );
      expect(body.archived_product_ids).toHaveLength(3);

      // SatsRail called exactly once per product
      expect(mockDeleteProduct).toHaveBeenCalledTimes(3);

      // Local rows are gone
      expect(await prisma.channel.findUnique({ where: { id: channel.id } })).toBeNull();
      expect(await prisma.media.count({ where: { channelId } })).toBe(0);
      expect(await countMediaProducts()).toBe(0);
      expect(await countChannelProducts()).toBe(0);

      // Audit fires with the archived ids
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "channel.delete",
          targetId: channelId,
          details: expect.objectContaining({
            media_count: 2,
            channel_product_count: 1,
            archived_product_ids: expect.arrayContaining([
              "prod_media_1",
              "prod_media_2",
              "prod_channel_1",
            ]),
          }),
        })
      );
    });

    it("completes Postgres cleanup even when SatsRail archive fails for one product", async () => {
      const channel = await createChannel({ name: "Partial", slug: "partial-ch" });
      const channelId = channel.id;
      const m1 = await createMedia(channelId, { name: "V1", sourceUrl: "https://x.com/1" });
      const m2 = await createMedia(channelId, { name: "V2", sourceUrl: "https://x.com/2" });
      await createMediaProduct({
          mediaId: m1.id,
          satsrailProductId: "prod_ok",
          encryptedSourceUrl: "blob",
        });
      await createMediaProduct({
          mediaId: m2.id,
          satsrailProductId: "prod_broken",
          encryptedSourceUrl: "blob2",
        });

      mockDeleteProduct.mockImplementation(async (_sk: string, productId: string) => {
        if (productId === "prod_broken") {
          throw new Error("SatsRail 500: server error");
        }
      });

      const [req, ctx] = buildRequest("DELETE", channelId);
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.archived_product_ids).toEqual(["prod_ok"]);
      expect(body.archive_errors).toEqual([
        { productId: "prod_broken", error: "SatsRail 500: server error" },
      ]);

      // DB cleanup ran regardless of partial failure
      expect(await prisma.channel.findUnique({ where: { id: channel.id } })).toBeNull();
      expect(await countMediaProducts()).toBe(0);
    });

    it("returns 404 for missing channel", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const [req, ctx] = buildRequest("DELETE", fakeId);
      const res = await DELETE(req, ctx);

      expect(res.status).toBe(404);
    });

    it("skips SatsRail archive when merchant key is unavailable but still hard-deletes", async () => {
      const channel = await createChannel({ name: "No Key", slug: "no-key-ch" });
      const media = await createMedia(channel.id, { name: "V" });
      await createMediaProduct({
          mediaId: media.id,
          satsrailProductId: "prod_skip",
          encryptedSourceUrl: "blob",
        });

      const merchantKey = await import("@/lib/merchant-key");
      vi.mocked(merchantKey.getMerchantKey).mockResolvedValueOnce(null);

      const [req, ctx] = buildRequest("DELETE", channel.id);
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockDeleteProduct).not.toHaveBeenCalled();

      // Local rows still removed
      expect(await prisma.channel.findUnique({ where: { id: channel.id } })).toBeNull();
      expect(await countMediaProducts()).toBe(0);
    });

    it("handles a non-Error throw from SatsRail.deleteProduct (falls back to 'Unknown error')", async () => {
      const channel = await createChannel({ name: "Weird Err", slug: "weird-err-ch" });
      const media = await createMedia(channel.id, { name: "V" });
      await createMediaProduct({
          mediaId: media.id,
          satsrailProductId: "prod_string_err",
          encryptedSourceUrl: "blob",
        });

      // Throw a non-Error so we hit the "Unknown error" fallback branch
      mockDeleteProduct.mockImplementationOnce(async () => {
        throw "string thrown not Error";
      });

      const [req, ctx] = buildRequest("DELETE", channel.id);
      const res = await DELETE(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.archive_errors).toEqual([
        { productId: "prod_string_err", error: "Unknown error" },
      ]);
    });
  });

  describe("PATCH /api/admin/channels/:id — optional field updates", () => {
    it("PATCH updates every optional field (full field-set coverage)", async () => {
      const channel = await createChannel({
        name: "Original",
        slug: "orig-slug",
      });
      const category = await prisma.category.create({
        data: { name: "Cat", slug: "cat-slug" },
      });
      const [req, ctx] = buildRequest("PATCH", channel.id, {
        name: "Renamed",
        slug: "renamed-slug",
        bio: "new bio",
        category_id: category.id,
        nsfw: true,
        profile_image_url: "https://example.com/p.jpg",
        social_links: { twitter: "https://x.com/y" },
        active: false,
        is_live: true,
        stream_url: "rtmp://example.com/live",
      });
      const res = await PATCH(req, ctx);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Renamed");
      expect(body.data.slug).toBe("renamed-slug");
      expect(body.data.bio).toBe("new bio");
      expect(body.data.categoryId).toBe(category.id);
      expect(body.data.nsfw).toBe(true);
      expect(body.data.profileImageUrl).toBe("https://example.com/p.jpg");
      expect(body.data.socialLinks).toEqual({ twitter: "https://x.com/y" });
      expect(body.data.active).toBe(false);
      expect(body.data.isLive).toBe(true);
      expect(body.data.streamUrl).toBe("rtmp://example.com/live");
    });

    it("PATCH disconnects category when category_id is null", async () => {
      const category = await prisma.category.create({
        data: { name: "Cat", slug: "cat-disconnect" },
      });
      const channel = await createChannel({
        name: "With cat",
        slug: "with-cat",
        categoryId: category.id,
      });
      const [req, ctx] = buildRequest("PATCH", channel.id, {
        category_id: null,
      });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(200);
      const fresh = await prisma.channel.findUnique({ where: { id: channel.id } });
      expect(fresh!.categoryId).toBeNull();
    });

    it("PATCH returns 400 for invalid payload", async () => {
      const channel = await createChannel({ name: "ValidatorTest", slug: "vt-slug" });
      const [req, ctx] = buildRequest("PATCH", channel.id, {
        nsfw: "not-a-boolean",
      });
      const res = await PATCH(req, ctx);
      expect(res.status).toBe(400);
    });
  });
});
