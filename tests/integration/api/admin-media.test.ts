import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct, createChannelProduct, findMediaProducts, findFirstMediaProduct } from "../../helpers/factories";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: vi.fn().mockResolvedValue("sk_test_key") }));
vi.mock("@/lib/content-encryption", () => ({
  encryptSourceUrl: vi.fn().mockReturnValue("encrypted_blob_base64"),
  decryptSourceUrl: vi.fn().mockReturnValue("https://example.com/video.mp4"),
}));

const { mockWrapDekFromBase64url } = vi.hoisted(() => ({
  mockWrapDekFromBase64url: vi.fn().mockReturnValue("kek-wrapped-dek-blob"),
}));
vi.mock("@/lib/content-dek", () => ({
  wrapDekFromBase64url: mockWrapDekFromBase64url,
}));

import { GET as listMedia, POST as createMediaRoute } from "@/app/api/admin/media/route";
import { GET as getMedia, PATCH as updateMedia, DELETE as deleteMedia } from "@/app/api/admin/media/[id]/route";
import { getMerchantKey } from "@/lib/merchant-key";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Admin Media API", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    vi.mocked(getMerchantKey).mockResolvedValue("sk_test_key");
    mockSatsrailClient.deleteProduct.mockReset();
  });

  async function seedChannel(): Promise<string> {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `test-channel-${nextRef()}`,
        name: "Test Channel",
        mediaCount: 0,
      },
    });
    return channel.id;
  }

  async function seedMedia(chId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: chId,
        name: "Test Video",
        blob: { kind: "url", url: "https://example.com/video.mp4" },
        mediaType: "video",
        position: 1,
        ...overrides,
      },
    });
    return media.id;
  }

  describe("GET /api/admin/media", () => {
    it("returns media by channel", async () => {
      const chId = await seedChannel();
      await seedMedia(chId);
      await seedMedia(chId, { name: "Second Video", position: 2 });

      const req = jsonRequest(`http://localhost:3000/api/admin/media?channel_id=${chId}`, "GET");
      const res = await listMedia(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe("Test Video");
    });

    it("returns 422 without channel_id", async () => {
      const req = jsonRequest("http://localhost:3000/api/admin/media", "GET");
      const res = await listMedia(req);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toBe("channel_id is required");
    });

    it("attaches product_ids when media has linked MediaProducts", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);
      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_for_list",
          encryptedSource: "blob",
        });

      const req = jsonRequest(`http://localhost:3000/api/admin/media?channel_id=${chId}`, "GET");
      const res = await listMedia(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data[0].product_ids).toEqual(["prod_for_list"]);
    });

    it("returns empty array when no media exists for channel", async () => {
      const chId = await seedChannel();
      const req = jsonRequest(`http://localhost:3000/api/admin/media?channel_id=${chId}`, "GET");
      const res = await listMedia(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data).toEqual([]);
    });
  });

  describe("POST /api/admin/media", () => {
    it("creates media", async () => {
      const chId = await seedChannel();
      mockSatsrailClient.getProductKey.mockResolvedValue({ key: "0".repeat(64) });

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "New Video",
        source_url: "https://example.com/new.mp4",
        media_type: "video",
      });
      const res = await createMediaRoute(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.name).toBe("New Video");
      expect(body.data.source_url).toBe("https://example.com/new.mp4");

      // Verify channel mediaCount incremented
      const channel = await prisma.channel.findUnique({ where: { id: chId } });
      expect(channel!.mediaCount).toBe(1);
    });

    it("returns 400 for invalid data (missing name)", async () => {
      const chId = await seedChannel();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        source_url: "https://example.com/new.mp4",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent channel", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: fakeId,
        name: "New Video",
        source_url: "https://example.com/new.mp4",
      });
      const res = await createMediaRoute(req);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Channel not found");
    });

    it("persists KEK-wrapped DEK on Media for photo + dek payload", async () => {
      const chId = await seedChannel();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "New Photo",
        source_url: "gridfs:photo-id",
        media_type: "photo",
        dek: "raw-dek-base64url",
      });
      const res = await createMediaRoute(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(mockWrapDekFromBase64url).toHaveBeenCalledWith("raw-dek-base64url");

      // The persisted doc should carry the wrapped DEK in Media.blob.
      const persisted = await prisma.media.findUnique({ where: { id: body.data.id ?? body.data._id } });
      const blob = persisted?.blob as { kind: string; encryptedDek?: string };
      expect(blob.kind).toBe("photo");
      expect(blob.encryptedDek).toBe("kek-wrapped-dek-blob");
    });

    it("photo creation rejects with 422 when KEK wrapping throws (DEK is required)", async () => {
      const chId = await seedChannel();
      mockWrapDekFromBase64url.mockImplementationOnce(() => {
        throw new Error("CONTENT_KEK is not set");
      });

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Failing Photo",
        source_url: "gridfs:photo-id",
        media_type: "photo",
        dek: "raw-dek-base64url",
      });
      const res = await createMediaRoute(req);
      const body = await res.json();

      // The new media route refuses to persist a photo without a usable DEK
      // (the blob's `encryptedDek` is a required field in the JSONB shape).
      expect(res.status).toBe(422);
      expect(body.error).toContain("Failed to KEK-wrap photo DEK");
    });

    it("does not call the DEK wrapper for non-photo media", async () => {
      const chId = await seedChannel();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Plain Video",
        source_url: "https://example.com/v.mp4",
        media_type: "video",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(201);
      expect(mockWrapDekFromBase64url).not.toHaveBeenCalled();
    });

    it("returns 422 when photo media is added to channel with existing products but no DEK", async () => {
      const chId = await seedChannel();
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_existing",
        });
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Photo No DEK",
        source_url: "gridfs:photo-x",
        media_type: "photo",
        // no dek!
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/dek is required/);
    });

    it("encrypts source_url for each existing ChannelProduct on the channel", async () => {
      const chId = await seedChannel();
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_cp_A",
          keyFingerprint: "fpA",
        });
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_cp_B",
          keyFingerprint: "fpB",
        });
      mockSatsrailClient.getProductKey.mockResolvedValue({ key: "0".repeat(64) });

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Multi-CP Video",
        source_url: "https://example.com/multi.mp4",
        media_type: "video",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(201);

      // Both channel-scoped Products should get a MediaEncryptedBlob entry for
      // the new media.
      const cps = await prisma.product.findMany({
        where: { channelId: chId },
        include: { mediaEncryptedBlobs: true },
      });
      const allEncrypted = cps.flatMap((cp) => cp.mediaEncryptedBlobs);
      expect(allEncrypted).toHaveLength(2);
    });

    it("encrypts photo DEK (rather than source_url) for existing ChannelProducts", async () => {
      const chId = await seedChannel();
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_cp_photo",
          keyFingerprint: "fp_photo",
        });
      mockSatsrailClient.getProductKey.mockResolvedValue({ key: "0".repeat(64) });
      const { encryptSourceUrl } = await import("@/lib/content-encryption");

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Photo With DEK",
        source_url: "gridfs:photo-zzz",
        media_type: "photo",
        dek: "rawdekbase64url",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(201);
      // For photo type, the DEK (not source_url) is the plaintext
      expect(vi.mocked(encryptSourceUrl)).toHaveBeenCalledWith(
        "rawdekbase64url",
        expect.any(String),
        "prod_cp_photo"
      );
    });

    it("swallows channel-product encryption errors so media creation still succeeds", async () => {
      const chId = await seedChannel();
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_failing",
          keyFingerprint: "fp_fail",
        });
      mockSatsrailClient.getProductKey.mockRejectedValue(new Error("portal blew up"));

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Recovers",
        source_url: "https://example.com/r.mp4",
        media_type: "video",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(201);
      // Media row exists despite encryption failure
      const media = await prisma.media.findFirst({ where: { name: "Recovers" } });
      expect(media).not.toBeNull();
    });

    it("skips channel product encryption when getMerchantKey returns null", async () => {
      const chId = await seedChannel();
      await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_no_key_cp",
          keyFingerprint: "fp",
        });
      vi.mocked(getMerchantKey).mockResolvedValueOnce(null);

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "No Key Path",
        source_url: "https://example.com/nk.mp4",
        media_type: "video",
      });
      const res = await createMediaRoute(req);
      expect(res.status).toBe(201);
      expect(mockSatsrailClient.getProductKey).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/admin/media/[id]", () => {
    it("returns media by ID", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "GET");
      const res = await getMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Test Video");
      expect(body.data.product_ids).toEqual([]);
    });

    it("returns 404 for non-existent media", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${fakeId}`, "GET");
      const res = await getMedia(req, { params: Promise.resolve({ id: fakeId }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });
  });

  describe("PATCH /api/admin/media/[id]", () => {
    it("updates media", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        name: "Updated Title",
        description: "Updated desc",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.name).toBe("Updated Title");
      expect(body.data.description).toBe("Updated desc");
    });

    it("returns 404 for non-existent media", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${fakeId}`, "PATCH", {
        name: "Nope",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: fakeId }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("updates every optional field (media_type, thumbnail_url, position, source_url)", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        media_type: "audio",
        thumbnail_url: "https://example.com/thumb.jpg",
        position: 42,
        source_url: "https://example.com/different.mp4",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);
      const m = await prisma.media.findUnique({ where: { id: mediaId } });
      expect(m!.mediaType).toBe("audio");
      expect(m!.thumbnailUrl).toBe("https://example.com/thumb.jpg");
      expect(m!.position).toBe(42);
      const updatedBlob = m!.blob as { kind: string; url?: string };
      expect(updatedBlob.url).toBe("https://example.com/different.mp4");
    });

    it("re-encrypts MediaProduct + ChannelProduct blobs when sourceUrl changes", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_reenc_m",
          encryptedSource: "old_blob",
        });
      const cp = await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_reenc_ch",
          encryptedMedia: [{ mediaId, encryptedSource: "old_ch_blob" }],
        });

      mockSatsrailClient.getProductKey.mockResolvedValue({ key: "0".repeat(64) });

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        source_url: "https://example.com/new-source.mp4",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      // Both blobs should be re-encrypted with the mocked encryptSourceUrl
      const updatedMp = await findFirstMediaProduct({ mediaId });
      expect(updatedMp!.encryptedSource).toBe("encrypted_blob_base64");
      const updatedCp = await prisma.mediaEncryptedBlob.findFirst({ where: { productId: cp.id, mediaId } });
      expect(updatedCp!.encryptedSource).toBe("encrypted_blob_base64");
    });

    it("skips re-encryption when sourceUrl is unchanged", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_same_url",
          encryptedSource: "unchanged_blob",
        });

      // PATCH with source_url same as existing should NOT re-encrypt
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        source_url: "https://example.com/video.mp4",  // same as seed
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      // getProductKey should not have been called
      expect(mockSatsrailClient.getProductKey).not.toHaveBeenCalled();

      const mp = await findFirstMediaProduct({ mediaId });
      expect(mp!.encryptedSource).toBe("unchanged_blob");
    });

    it("re-encrypt swallows errors when getMerchantKey returns null", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_no_key_reenc",
          encryptedSource: "old_blob",
        });

      vi.mocked(getMerchantKey).mockResolvedValueOnce(null);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        source_url: "https://example.com/changed.mp4",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      // Should not have called getProductKey since sk is null
      expect(mockSatsrailClient.getProductKey).not.toHaveBeenCalled();

      // MediaProduct blob unchanged
      const mp = await findFirstMediaProduct({ mediaId });
      expect(mp!.encryptedSource).toBe("old_blob");
    });

    it("re-encrypt catches and logs errors from satsrail.getProductKey", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_reenc_err",
          encryptedSource: "old_blob",
        });

      mockSatsrailClient.getProductKey.mockRejectedValue(new Error("SatsRail timeout"));

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        source_url: "https://example.com/diff.mp4",
      });
      // Should still succeed even though re-encrypt fails
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);
    });

    it("returns 400 when validation fails (invalid media_type)", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "PATCH", {
        media_type: "not-a-valid-type",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/admin/media/[id]", () => {
    it("hard-deletes media and decrements channel mediaCount", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await prisma.channel.update({ where: { id: chId }, data: { mediaCount: 1 } });

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Row is gone
      const media = await prisma.media.findUnique({ where: { id: mediaId } });
      expect(media).toBeNull();

      const channel = await prisma.channel.findUnique({ where: { id: chId } });
      expect(channel!.mediaCount).toBe(0);
    });

    it("returns 404 for non-existent media", async () => {
      const fakeId = "ckmissingfakefakefakefake";
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${fakeId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: fakeId }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("cleans up legacy soft-deleted media without double-decrementing channel count", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId, { deletedAt: new Date() });

      // Channel count was already decremented when this was soft-deleted previously
      await prisma.channel.update({ where: { id: chId }, data: { mediaCount: 5 } });

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_leftover",
          encryptedSource: "blob",
        });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Row hard-deleted
      const media = await prisma.media.findUnique({ where: { id: mediaId } });
      expect(media).toBeNull();

      // SatsRail archive ran for the leftover product
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_leftover");

      const remaining = await findMediaProducts({ mediaId });
      expect(remaining).toHaveLength(0);

      // Channel count NOT decremented again (was already decremented at soft-delete time)
      const channel = await prisma.channel.findUnique({ where: { id: chId } });
      expect(channel!.mediaCount).toBe(5);
    });

    it("removes media from channel product encrypted_media", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const cp = await createChannelProduct({
          channelId: chId,
          satsrailProductId: "prod_abc",
          encryptedMedia: [{ mediaId, encryptedSource: "blob" }],
        });

      await prisma.channel.update({ where: { id: chId }, data: { mediaCount: 1 } });

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      const updated = await prisma.product.findUnique({
        where: { id: cp.id },
        include: { mediaEncryptedBlobs: true },
      });
      expect(updated!.mediaEncryptedBlobs).toHaveLength(0);
    });

    it("archives associated MediaProduct on SatsRail and removes the local record", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_individual_1",
          encryptedSource: "blob",
        });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledTimes(1);
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_individual_1");

      const remaining = await findMediaProducts({ mediaId });
      expect(remaining).toHaveLength(0);
    });

    it("archives every MediaProduct when multiple products are tied to media", async () => {
      const chId = await seedChannel();
      const mediaIdA = await seedMedia(chId);
      const mediaIdB = await seedMedia(chId, { position: 2 });

      await createMediaProduct({
          mediaId: mediaIdA,
          satsrailProductId: "prod_A",
          encryptedSource: "blobA",
        });
      await createMediaProduct({
          mediaId: mediaIdB,
          satsrailProductId: "prod_B",
          encryptedSource: "blobB",
        });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      // Delete first media — only prod_A should be archived
      const reqA = jsonRequest(`http://localhost:3000/api/admin/media/${mediaIdA}`, "DELETE");
      const resA = await deleteMedia(reqA, { params: Promise.resolve({ id: mediaIdA }) });
      expect(resA.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledTimes(1);
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_A");

      // prod_B should still exist
      const remaining = await findFirstMediaProduct({ satsrailProductId: "prod_B" });
      expect(remaining).not.toBeNull();
    });

    it("still hard-deletes media when SatsRail archive fails", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_failing",
          encryptedSource: "blob",
        });

      await prisma.channel.update({ where: { id: chId }, data: { mediaCount: 1 } });

      mockSatsrailClient.deleteProduct.mockRejectedValue(new Error("SatsRail down"));

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      // Local hard-delete proceeded
      const media = await prisma.media.findUnique({ where: { id: mediaId } });
      expect(media).toBeNull();

      const remaining = await findMediaProducts({ mediaId });
      expect(remaining).toHaveLength(0);

      const channel = await prisma.channel.findUnique({ where: { id: chId } });
      expect(channel!.mediaCount).toBe(0);
    });

    it("skips SatsRail call when merchant key is unavailable but still hard-deletes", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await createMediaProduct({
          mediaId,
          satsrailProductId: "prod_no_key",
          encryptedSource: "blob",
        });

      vi.mocked(getMerchantKey).mockResolvedValueOnce(null);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).not.toHaveBeenCalled();

      const media = await prisma.media.findUnique({ where: { id: mediaId } });
      expect(media).toBeNull();

      const remaining = await findMediaProducts({ mediaId });
      expect(remaining).toHaveLength(0);
    });

    it("does not call SatsRail when media has no MediaProducts", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).not.toHaveBeenCalled();
    });

    it("removes the encrypted photo blob row when deleting photo media", async () => {
      const chId = await seedChannel();
      const blob = await prisma.encryptedEnvelope.create({
        data: { bytes: Buffer.from("photo-bytes"), mimeType: "image/jpeg" },
      });
      const photoMedia = await prisma.media.create({
        data: {
          ref: nextRef(),
          channelId: chId,
          name: "Photo",
          description: "",
          blob: {
            kind: "photo",
            envelopeId: blob.id,
            encryptedDek: "test_dek",
            mimeType: "image/jpeg",
          },
          mediaType: "photo",
          position: 1,
        },
      });

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia.id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia.id }),
      });
      expect(res.status).toBe(200);

      // EncryptedEnvelope cleanup happened
      const remaining = await prisma.encryptedEnvelope.findUnique({ where: { id: blob.id } });
      expect(remaining).toBeNull();
    });

    it("non-photo media delete does NOT touch encrypted photo blobs", async () => {
      const chId = await seedChannel();
      const blob = await prisma.encryptedEnvelope.create({
        data: { bytes: Buffer.from("photo-bytes"), mimeType: "image/jpeg" },
      });
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });

      // The unrelated blob still exists
      const remaining = await prisma.encryptedEnvelope.findUnique({ where: { id: blob.id } });
      expect(remaining).not.toBeNull();
    });

    it("photo media delete tolerates missing blob row (logs, does not fail the request)", async () => {
      const chId = await seedChannel();
      const photoMedia = await prisma.media.create({
        data: {
          ref: nextRef(),
          channelId: chId,
          name: "PhotoBroken",
          description: "",
          blob: { kind: "url", url: "missing-blob-id" },
          mediaType: "photo",
          position: 1,
        },
      });

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia.id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia.id }),
      });
      // The DELETE still succeeds — orphan bytes are a soft failure
      expect(res.status).toBe(200);
      const stillThere = await prisma.media.findUnique({ where: { id: photoMedia.id } });
      expect(stillThere).toBeNull();
    });

    it("photo media with non-blob-id sourceUrl is skipped without error", async () => {
      const chId = await seedChannel();
      const photoMedia = await prisma.media.create({
        data: {
          ref: nextRef(),
          channelId: chId,
          name: "PhotoLegacy",
          description: "",
          blob: { kind: "url", url: "legacy-non-blob-id-string" },
          mediaType: "photo",
          position: 1,
        },
      });

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia.id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia.id }),
      });
      expect(res.status).toBe(200);
    });
  });
});
