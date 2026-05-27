import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

import {
  cleanupOrphanEnvelopes,
  DEFAULT_ORPHAN_GRACE_MS,
} from "@/lib/envelope-cleanup";

async function createPhotoBlob(opts: { createdAt?: Date } = {}) {
  const blob = await prisma.encryptedEnvelope.create({
    data: {
      bytes: Buffer.from("photo-bytes"),
      mimeType: "image/jpeg",
    },
  });
  if (opts.createdAt) {
    await prisma.$executeRaw`
      UPDATE "EncryptedEnvelope" SET "createdAt" = ${opts.createdAt.toISOString()}::timestamp WHERE id = ${blob.id}
    `;
  }
  return blob;
}

async function createPhotoMedia(channelId: string, envelopeId: string, refOverride?: number) {
  return prisma.media.create({
    data: {
      ref: refOverride ?? Math.floor(Math.random() * 1_000_000),
      channelId,
      name: `Photo ${envelopeId.slice(-6)}`,
      description: "",
      blob: {
        kind: "photo",
        envelopeId,
        encryptedDek: "test_dek",
        mimeType: "image/jpeg",
      },
      mediaType: "photo",
      position: 1,
    },
  });
}

async function createArticleMedia(channelId: string, envelopeId: string, refOverride?: number) {
  return prisma.media.create({
    data: {
      ref: refOverride ?? Math.floor(Math.random() * 1_000_000),
      channelId,
      name: `Article ${envelopeId.slice(-6)}`,
      description: "",
      blob: {
        kind: "article",
        envelopeId,
        encryptedDek: "test_dek",
        mimeType: "text/markdown; charset=utf-8",
      },
      mediaType: "article",
      position: 1,
    },
  });
}

describe("cleanupOrphanEnvelopes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("deletes a blob with no referencing Media row (older than grace)", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    const orphan = await createPhotoBlob({ createdAt: old });

    const result = await cleanupOrphanEnvelopes();

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(0);

    const remaining = await prisma.encryptedEnvelope.findUnique({ where: { id: orphan.id } });
    expect(remaining).toBeNull();
  });

  it("preserves a blob that IS referenced by a Media row", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const referenced = await createPhotoBlob({ createdAt: old });
    await createPhotoMedia(channel.id, referenced.id);

    const result = await cleanupOrphanEnvelopes();

    expect(result.scanned).toBe(1);
    expect(result.referenced).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);

    const stillThere = await prisma.encryptedEnvelope.findUnique({ where: { id: referenced.id } });
    expect(stillThere).not.toBeNull();
  });

  it("skips orphan blobs younger than the grace period", async () => {
    const young = new Date(Date.now() - 5 * 60 * 1000); // 5min ago
    await createPhotoBlob({ createdAt: young });

    const result = await cleanupOrphanEnvelopes();

    expect(result.orphaned).toBe(1);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it("deletes orphan blobs of any age when graceMs is 0", async () => {
    await createPhotoBlob({ createdAt: new Date() });

    const result = await cleanupOrphanEnvelopes({ graceMs: 0 });

    expect(result.deleted).toBe(1);
    expect(result.skippedYoung).toBe(0);
  });

  it("dryRun reports without deleting", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const blob = await createPhotoBlob({ createdAt: old });

    const result = await cleanupOrphanEnvelopes({ dryRun: true });

    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(0);
    const stillThere = await prisma.encryptedEnvelope.findUnique({ where: { id: blob.id } });
    expect(stillThere).not.toBeNull();
  });

  it("mixed batch — referenced kept, young orphan kept, old orphan deleted", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const young = new Date(Date.now() - 5 * 60 * 1000);

    const kept = await createPhotoBlob({ createdAt: old });
    const youngOrphan = await createPhotoBlob({ createdAt: young });
    const oldOrphan = await createPhotoBlob({ createdAt: old });
    await createPhotoMedia(channel.id, kept.id);

    const result = await cleanupOrphanEnvelopes();

    expect(result.scanned).toBe(3);
    expect(result.referenced).toBe(1);
    expect(result.orphaned).toBe(2);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(1);

    // old orphan deleted, others preserved
    expect(await prisma.encryptedEnvelope.findUnique({ where: { id: oldOrphan.id } })).toBeNull();
    expect(await prisma.encryptedEnvelope.findUnique({ where: { id: youngOrphan.id } })).not.toBeNull();
    expect(await prisma.encryptedEnvelope.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it("only matches Media rows where mediaType is 'photo' or 'article' (a non-envelope row with the same id does NOT protect a blob)", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const blob = await createPhotoBlob({ createdAt: old });
    // Create a NON-envelope media that coincidentally references the blob.id.
    // The cleanup filter `mediaType in ["photo", "article"]` should exclude it.
    await prisma.media.create({
      data: {
        ref: 42,
        channelId: channel.id,
        name: "Video with confusing URL",
        description: "",
        blob: { kind: "url", url: blob.id },
        mediaType: "video",
        position: 1,
      },
    });

    const result = await cleanupOrphanEnvelopes();
    expect(result.referenced).toBe(0);
    expect(result.deleted).toBe(1);
  });

  it("preserves a blob referenced by an article Media row (envelope kind)", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const referenced = await createPhotoBlob({ createdAt: old });
    await createArticleMedia(channel.id, referenced.id);

    const result = await cleanupOrphanEnvelopes();
    expect(result.referenced).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it("DEFAULT_ORPHAN_GRACE_MS is one hour", () => {
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(60 * 60 * 1000);
  });

  it("scans an empty table cleanly", async () => {
    const result = await cleanupOrphanEnvelopes();
    expect(result).toEqual({
      scanned: 0,
      referenced: 0,
      orphaned: 0,
      deleted: 0,
      skippedYoung: 0,
      errors: [],
    });
  });
});
