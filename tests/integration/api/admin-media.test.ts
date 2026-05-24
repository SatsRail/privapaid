import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })) }));
vi.mock("@/lib/mongodb", () => ({ connectDB: vi.fn().mockImplementation(async () => mongoose) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireCustomerApi: vi.fn().mockResolvedValue({ id: "customer-1", name: "testuser" }),
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
vi.mock("@/lib/photo-dek", () => ({
  wrapDekFromBase64url: mockWrapDekFromBase64url,
}));

const { mockGridFsDelete } = vi.hoisted(() => ({ mockGridFsDelete: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/gridfs", () => ({
  getEncryptedPhotosBucket: vi.fn().mockResolvedValue({ delete: mockGridFsDelete }),
}));

import { GET as listMedia, POST as createMedia } from "@/app/api/admin/media/route";
import { GET as getMedia, PATCH as updateMedia, DELETE as deleteMedia } from "@/app/api/admin/media/[id]/route";
import { getMerchantKey } from "@/lib/merchant-key";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";

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
    const channel = await Channel.create({
      ref: 1,
      slug: "test-channel",
      name: "Test Channel",
      media_count: 0,
    });
    return String(channel._id);
  }

  async function seedMedia(chId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const media = await Media.create({
      ref: 100,
      channel_id: chId,
      name: "Test Video",
      source_url: "https://example.com/video.mp4",
      media_type: "video",
      position: 1,
      ...overrides,
    });
    return String(media._id);
  }

  describe("GET /api/admin/media", () => {
    it("returns media by channel", async () => {
      const chId = await seedChannel();
      await seedMedia(chId);
      await seedMedia(chId, { ref: 101, name: "Second Video", position: 2 });

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
      const res = await createMedia(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.name).toBe("New Video");
      expect(body.data.source_url).toBe("https://example.com/new.mp4");

      // Verify channel media_count incremented
      const channel = await Channel.findById(chId);
      expect(channel!.media_count).toBe(1);
    });

    it("returns 400 for invalid data (missing name)", async () => {
      const chId = await seedChannel();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        source_url: "https://example.com/new.mp4",
      });
      const res = await createMedia(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent channel", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: fakeId,
        name: "New Video",
        source_url: "https://example.com/new.mp4",
      });
      const res = await createMedia(req);
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
      const res = await createMedia(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(mockWrapDekFromBase64url).toHaveBeenCalledWith("raw-dek-base64url");

      // The persisted doc should carry the wrapped DEK exactly as wrapDek returned.
      const persisted = await Media.findById(body.data._id);
      expect(persisted?.encrypted_dek).toBe("kek-wrapped-dek-blob");
    });

    it("photo creation succeeds even when KEK wrapping throws (non-fatal)", async () => {
      const chId = await seedChannel();
      mockWrapDekFromBase64url.mockImplementationOnce(() => {
        throw new Error("PHOTO_KEK is not set");
      });

      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Resilient Photo",
        source_url: "gridfs:photo-id",
        media_type: "photo",
        dek: "raw-dek-base64url",
      });
      const res = await createMedia(req);
      const body = await res.json();

      expect(res.status).toBe(201);
      const persisted = await Media.findById(body.data._id);
      expect(persisted?.encrypted_dek).toBeUndefined();
    });

    it("does not call the DEK wrapper for non-photo media", async () => {
      const chId = await seedChannel();
      const req = jsonRequest("http://localhost:3000/api/admin/media", "POST", {
        channel_id: chId,
        name: "Plain Video",
        source_url: "https://example.com/v.mp4",
        media_type: "video",
      });
      const res = await createMedia(req);
      expect(res.status).toBe(201);
      expect(mockWrapDekFromBase64url).not.toHaveBeenCalled();
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
      const fakeId = new mongoose.Types.ObjectId().toString();
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
      const fakeId = new mongoose.Types.ObjectId().toString();
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${fakeId}`, "PATCH", {
        name: "Nope",
      });
      const res = await updateMedia(req, { params: Promise.resolve({ id: fakeId }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });
  });

  describe("DELETE /api/admin/media/[id]", () => {
    it("hard-deletes media from MongoDB and decrements channel media_count", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await Channel.findByIdAndUpdate(chId, { media_count: 1 });

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Row is gone from Mongo
      const media = await Media.findById(mediaId);
      expect(media).toBeNull();

      const channel = await Channel.findById(chId);
      expect(channel!.media_count).toBe(0);
    });

    it("returns 404 for non-existent media", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const req = jsonRequest(`http://localhost:3000/api/admin/media/${fakeId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: fakeId }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Not found");
    });

    it("cleans up legacy soft-deleted media without double-decrementing channel count", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId, { deleted_at: new Date() });

      // Channel count was already decremented when this was soft-deleted previously
      await Channel.findByIdAndUpdate(chId, { media_count: 5 });

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_leftover",
        encrypted_source_url: "blob",
      });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Row hard-deleted
      const media = await Media.findById(mediaId);
      expect(media).toBeNull();

      // SatsRail archive ran for the leftover product
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_leftover");

      const remaining = await MediaProduct.find({ media_id: mediaId });
      expect(remaining).toHaveLength(0);

      // Channel count NOT decremented again (was already decremented at soft-delete time)
      const channel = await Channel.findById(chId);
      expect(channel!.media_count).toBe(5);
    });

    it("removes media from channel product encrypted_media", async () => {
      const { default: ChannelProduct } = await import("@/models/ChannelProduct");
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const cp = await ChannelProduct.create({
        channel_id: chId,
        satsrail_product_id: "prod_abc",
        encrypted_media: [{ media_id: new mongoose.Types.ObjectId(mediaId), encrypted_source_url: "blob" }],
      });

      await Channel.findByIdAndUpdate(chId, { media_count: 1 });

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      const updated = await ChannelProduct.findById(cp._id);
      expect(updated!.encrypted_media).toHaveLength(0);
    });

    it("archives associated MediaProduct on SatsRail and removes the local record", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_individual_1",
        encrypted_source_url: "blob",
      });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledTimes(1);
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_individual_1");

      const remaining = await MediaProduct.find({ media_id: mediaId });
      expect(remaining).toHaveLength(0);
    });

    it("archives every MediaProduct when multiple products are tied to media", async () => {
      const chId = await seedChannel();
      const mediaIdA = await seedMedia(chId, { ref: 100 });

      // Two MediaProducts on the same media — schema allows the array to grow
      // even if media_id is unique-indexed only one row is permitted, so use a
      // different media row and verify the loop iterates.
      const mediaIdB = await seedMedia(chId, { ref: 101, position: 2 });

      await MediaProduct.create({
        media_id: mediaIdA,
        satsrail_product_id: "prod_A",
        encrypted_source_url: "blobA",
      });
      await MediaProduct.create({
        media_id: mediaIdB,
        satsrail_product_id: "prod_B",
        encrypted_source_url: "blobB",
      });

      mockSatsrailClient.deleteProduct.mockResolvedValue(undefined);

      // Delete first media — only prod_A should be archived
      const reqA = jsonRequest(`http://localhost:3000/api/admin/media/${mediaIdA}`, "DELETE");
      const resA = await deleteMedia(reqA, { params: Promise.resolve({ id: mediaIdA }) });
      expect(resA.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledTimes(1);
      expect(mockSatsrailClient.deleteProduct).toHaveBeenCalledWith("sk_test_key", "prod_A");

      // prod_B should still exist
      const remaining = await MediaProduct.findOne({ satsrail_product_id: "prod_B" });
      expect(remaining).not.toBeNull();
    });

    it("still hard-deletes media when SatsRail archive fails", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_failing",
        encrypted_source_url: "blob",
      });

      await Channel.findByIdAndUpdate(chId, { media_count: 1 });

      mockSatsrailClient.deleteProduct.mockRejectedValue(new Error("SatsRail down"));

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      // Local hard-delete proceeded
      const media = await Media.findById(mediaId);
      expect(media).toBeNull();

      const remaining = await MediaProduct.find({ media_id: mediaId });
      expect(remaining).toHaveLength(0);

      const channel = await Channel.findById(chId);
      expect(channel!.media_count).toBe(0);
    });

    it("skips SatsRail call when merchant key is unavailable but still hard-deletes", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      await MediaProduct.create({
        media_id: mediaId,
        satsrail_product_id: "prod_no_key",
        encrypted_source_url: "blob",
      });

      vi.mocked(getMerchantKey).mockResolvedValueOnce(null);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      const res = await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });
      expect(res.status).toBe(200);

      expect(mockSatsrailClient.deleteProduct).not.toHaveBeenCalled();

      const media = await Media.findById(mediaId);
      expect(media).toBeNull();

      const remaining = await MediaProduct.find({ media_id: mediaId });
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

    it("removes the encrypted GridFS file when deleting photo media", async () => {
      const chId = await seedChannel();
      const gridFsId = new mongoose.Types.ObjectId();
      const photoMedia = await Media.create({
        ref: 999,
        channel_id: chId,
        name: "Photo",
        description: "",
        source_url: gridFsId.toString(),
        media_type: "photo",
        position: 1,
        comments_count: 0,
        flags_count: 0,
      });

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia._id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia._id.toString() }),
      });
      expect(res.status).toBe(200);

      // GridFS cleanup happened with the right ObjectId
      expect(mockGridFsDelete).toHaveBeenCalledTimes(1);
      const arg = mockGridFsDelete.mock.calls[0][0];
      expect(arg.toString()).toBe(gridFsId.toString());
    });

    it("non-photo media delete does NOT touch the encrypted GridFS bucket", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId);

      const req = jsonRequest(`http://localhost:3000/api/admin/media/${mediaId}`, "DELETE");
      await deleteMedia(req, { params: Promise.resolve({ id: mediaId }) });

      expect(mockGridFsDelete).not.toHaveBeenCalled();
    });

    it("photo media delete tolerates GridFS errors (logs, does not fail the request)", async () => {
      const chId = await seedChannel();
      const gridFsId = new mongoose.Types.ObjectId();
      const photoMedia = await Media.create({
        ref: 1000,
        channel_id: chId,
        name: "PhotoBroken",
        description: "",
        source_url: gridFsId.toString(),
        media_type: "photo",
        position: 1,
        comments_count: 0,
        flags_count: 0,
      });

      mockGridFsDelete.mockRejectedValueOnce(new Error("gridfs unavailable"));

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia._id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia._id.toString() }),
      });
      // The DELETE still succeeds — orphan bytes are a soft failure
      expect(res.status).toBe(200);
      const stillThere = await Media.findById(photoMedia._id);
      expect(stillThere).toBeNull();
    });

    it("photo media with non-ObjectId source_url is skipped without error", async () => {
      const chId = await seedChannel();
      const photoMedia = await Media.create({
        ref: 1001,
        channel_id: chId,
        name: "PhotoLegacy",
        description: "",
        source_url: "legacy-non-objectid-string",
        media_type: "photo",
        position: 1,
        comments_count: 0,
        flags_count: 0,
      });

      const req = jsonRequest(
        `http://localhost:3000/api/admin/media/${photoMedia._id}`,
        "DELETE"
      );
      const res = await deleteMedia(req, {
        params: Promise.resolve({ id: photoMedia._id.toString() }),
      });
      expect(res.status).toBe(200);
      expect(mockGridFsDelete).not.toHaveBeenCalled();
    });
  });
});
