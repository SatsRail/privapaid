import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { ObjectId } from "mongodb";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

// ── Hoisted GridFS mock ───────────────────────────────────────────────
const { mockBucketFind, mockBucketDelete } = vi.hoisted(() => ({
  mockBucketFind: vi.fn(),
  mockBucketDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/gridfs", () => ({
  getEncryptedPhotosBucket: vi.fn().mockResolvedValue({
    find: mockBucketFind,
    delete: mockBucketDelete,
  }),
}));

import {
  cleanupOrphanEncryptedPhotos,
  DEFAULT_ORPHAN_GRACE_MS,
} from "@/lib/photo-cleanup";
import Media from "@/models/Media";
import { createChannel } from "../../helpers/factories";

interface FakeGridFsFile {
  _id: ObjectId;
  uploadDate: Date;
}

function asyncIter(files: FakeGridFsFile[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of files) yield f;
    },
  };
}

function mockBucketContents(files: FakeGridFsFile[]) {
  mockBucketFind.mockReturnValueOnce(asyncIter(files));
}

async function createPhotoMedia(channelId: string, gridFsId: ObjectId, refOverride?: number) {
  return Media.create({
    ref: refOverride ?? Math.floor(Math.random() * 1_000_000),
    channel_id: channelId,
    name: `Photo ${gridFsId.toString().slice(-6)}`,
    description: "",
    source_url: gridFsId.toString(),
    media_type: "photo",
    position: 1,
    comments_count: 0,
    flags_count: 0,
  });
}

describe("cleanupOrphanEncryptedPhotos", () => {
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

  it("deletes a GridFS file with no referencing Media row (older than grace)", async () => {
    const orphanId = new ObjectId();
    mockBucketContents([
      { _id: orphanId, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2h ago
    ]);

    const result = await cleanupOrphanEncryptedPhotos();

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockBucketDelete).toHaveBeenCalledTimes(1);
    expect((mockBucketDelete.mock.calls[0][0] as ObjectId).toString()).toBe(
      orphanId.toString()
    );
  });

  it("preserves a GridFS file that IS referenced by a Media row", async () => {
    const channel = await createChannel();
    const referencedId = new ObjectId();
    await createPhotoMedia(channel._id.toString(), referencedId);

    mockBucketContents([
      { _id: referencedId, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    ]);

    const result = await cleanupOrphanEncryptedPhotos();

    expect(result.scanned).toBe(1);
    expect(result.referenced).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
    expect(mockBucketDelete).not.toHaveBeenCalled();
  });

  it("skips orphan files younger than the grace period", async () => {
    const youngOrphan = new ObjectId();
    mockBucketContents([
      { _id: youngOrphan, uploadDate: new Date(Date.now() - 5 * 60 * 1000) }, // 5min ago
    ]);

    const result = await cleanupOrphanEncryptedPhotos();

    expect(result.orphaned).toBe(1);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mockBucketDelete).not.toHaveBeenCalled();
  });

  it("deletes orphan files of any age when graceMs is 0", async () => {
    const justUploaded = new ObjectId();
    mockBucketContents([{ _id: justUploaded, uploadDate: new Date() }]);

    const result = await cleanupOrphanEncryptedPhotos({ graceMs: 0 });

    expect(result.deleted).toBe(1);
    expect(result.skippedYoung).toBe(0);
  });

  it("dryRun reports without deleting", async () => {
    const orphanId = new ObjectId();
    mockBucketContents([
      { _id: orphanId, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    ]);

    const result = await cleanupOrphanEncryptedPhotos({ dryRun: true });

    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mockBucketDelete).not.toHaveBeenCalled();
  });

  it("collects errors and continues across the rest of the batch", async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const c = new ObjectId();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockBucketContents([
      { _id: a, uploadDate: old },
      { _id: b, uploadDate: old },
      { _id: c, uploadDate: old },
    ]);

    // Middle file delete fails — first and third should still succeed.
    mockBucketDelete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("gridfs broke on b"))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupOrphanEncryptedPhotos();

    expect(result.scanned).toBe(3);
    expect(result.orphaned).toBe(3);
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].gridFsId).toBe(b.toString());
    expect(result.errors[0].error).toMatch(/gridfs broke on b/);
  });

  it("mixed batch — referenced kept, young orphan kept, old orphan deleted", async () => {
    const channel = await createChannel();

    const kept = new ObjectId();
    const young = new ObjectId();
    const oldOrphan = new ObjectId();
    await createPhotoMedia(channel._id.toString(), kept);

    mockBucketContents([
      { _id: kept, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      { _id: young, uploadDate: new Date(Date.now() - 5 * 60 * 1000) },
      { _id: oldOrphan, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    ]);

    const result = await cleanupOrphanEncryptedPhotos();

    expect(result.scanned).toBe(3);
    expect(result.referenced).toBe(1);
    expect(result.orphaned).toBe(2);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(1);

    expect(mockBucketDelete).toHaveBeenCalledTimes(1);
    expect((mockBucketDelete.mock.calls[0][0] as ObjectId).toString()).toBe(
      oldOrphan.toString()
    );
  });

  it("only matches Media rows where media_type is 'photo' (a non-photo row with the same source_url string does NOT protect a file)", async () => {
    const channel = await createChannel();
    const fileId = new ObjectId();
    // Create a NON-photo media that coincidentally has the GridFS id as source_url.
    await Media.create({
      ref: 42,
      channel_id: channel._id,
      name: "Video with confusing URL",
      description: "",
      source_url: fileId.toString(),
      media_type: "video",
      position: 1,
      comments_count: 0,
      flags_count: 0,
    });

    mockBucketContents([
      { _id: fileId, uploadDate: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    ]);

    const result = await cleanupOrphanEncryptedPhotos();
    // The video row does NOT count as a reference for the encrypted-photo bucket
    expect(result.referenced).toBe(0);
    expect(result.deleted).toBe(1);
  });

  it("DEFAULT_ORPHAN_GRACE_MS is one hour", () => {
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(60 * 60 * 1000);
  });

  it("scans an empty bucket cleanly", async () => {
    mockBucketContents([]);
    const result = await cleanupOrphanEncryptedPhotos();
    expect(result).toEqual({
      scanned: 0,
      referenced: 0,
      orphaned: 0,
      deleted: 0,
      skippedYoung: 0,
      errors: [],
    });
    expect(mockBucketDelete).not.toHaveBeenCalled();
  });

  it("treats missing uploadDate as immediately eligible for deletion", async () => {
    const noDate = new ObjectId();
    mockBucketContents([{ _id: noDate, uploadDate: undefined as unknown as Date }]);

    const result = await cleanupOrphanEncryptedPhotos();
    expect(result.deleted).toBe(1);
    expect(result.skippedYoung).toBe(0);
  });
});

// Reference unused imports to satisfy the linter when the harness file shrinks
void mongoose;
