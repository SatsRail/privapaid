import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { createEnvelopeArtifacts } from "@/lib/media-envelope";
import { prisma } from "@/lib/prisma";

import {
  cleanupOrphanEnvelopes,
  DEFAULT_ORPHAN_GRACE_MS,
} from "@/lib/envelope-cleanup";

/**
 * Create an ORPHAN MediaEnvelope: a staged ciphertext row whose Media was never
 * created, so `mediaId IS NULL`. Under the dropped-Media.blob model this is the
 * ONLY orphan shape — cleanup scans exactly these rows.
 */
async function createOrphanEnvelope(opts: { createdAt?: Date } = {}) {
  const art = createEnvelopeArtifacts(Buffer.from("photo-bytes"));
  const envelope = await prisma.mediaEnvelope.create({
    data: {
      // mediaId intentionally null — this is the orphan condition.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bytes: art.bytes as any,
      mimeType: "image/jpeg",
      wrappedDek: art.wrappedDek,
    },
  });
  if (opts.createdAt) {
    await prisma.$executeRaw`
      UPDATE "MediaEnvelope" SET "createdAt" = ${opts.createdAt.toISOString()}::timestamp WHERE id = ${envelope.id}
    `;
  }
  return envelope;
}

/**
 * Create a Media with its paired (linked) MediaEnvelope — `mediaId` is set, so
 * the envelope is NOT an orphan and cleanup never scans it. Returns the linked
 * envelope row.
 */
async function createLinkedEnvelope(
  channelId: string,
  mediaType: "photo" | "article" = "photo"
) {
  const media = await createMedia(channelId, { mediaType });
  const envelope = await prisma.mediaEnvelope.findUnique({ where: { mediaId: media.id } });
  return envelope!;
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

  it("deletes an orphan envelope (mediaId null, older than grace)", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    const orphan = await createOrphanEnvelope({ createdAt: old });

    const result = await cleanupOrphanEnvelopes();

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(0);

    const remaining = await prisma.mediaEnvelope.findUnique({ where: { id: orphan.id } });
    expect(remaining).toBeNull();
  });

  it("never scans a linked envelope (mediaId set) — it is left untouched", async () => {
    const channel = await createChannel();
    const referenced = await createLinkedEnvelope(channel.id);

    const result = await cleanupOrphanEnvelopes();

    // Linked rows are filtered out of the scan entirely (where: mediaId null).
    expect(result.scanned).toBe(0);
    expect(result.referenced).toBe(0);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);

    const stillThere = await prisma.mediaEnvelope.findUnique({ where: { id: referenced.id } });
    expect(stillThere).not.toBeNull();
  });

  it("skips orphan envelopes younger than the grace period", async () => {
    const young = new Date(Date.now() - 5 * 60 * 1000); // 5min ago
    await createOrphanEnvelope({ createdAt: young });

    const result = await cleanupOrphanEnvelopes();

    expect(result.orphaned).toBe(1);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it("deletes orphan envelopes of any age when graceMs is 0", async () => {
    await createOrphanEnvelope({ createdAt: new Date() });

    const result = await cleanupOrphanEnvelopes({ graceMs: 0 });

    expect(result.deleted).toBe(1);
    expect(result.skippedYoung).toBe(0);
  });

  it("dryRun reports without deleting", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const orphan = await createOrphanEnvelope({ createdAt: old });

    const result = await cleanupOrphanEnvelopes({ dryRun: true });

    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(0);
    const stillThere = await prisma.mediaEnvelope.findUnique({ where: { id: orphan.id } });
    expect(stillThere).not.toBeNull();
  });

  it("mixed batch — linked not scanned, young orphan kept, old orphan deleted", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const young = new Date(Date.now() - 5 * 60 * 1000);

    const linked = await createLinkedEnvelope(channel.id);
    const youngOrphan = await createOrphanEnvelope({ createdAt: young });
    const oldOrphan = await createOrphanEnvelope({ createdAt: old });

    const result = await cleanupOrphanEnvelopes();

    // Only the two mediaId-null rows are scanned; the linked one is invisible.
    expect(result.scanned).toBe(2);
    expect(result.referenced).toBe(0);
    expect(result.orphaned).toBe(2);
    expect(result.skippedYoung).toBe(1);
    expect(result.deleted).toBe(1);

    // old orphan deleted, others preserved
    expect(await prisma.mediaEnvelope.findUnique({ where: { id: oldOrphan.id } })).toBeNull();
    expect(await prisma.mediaEnvelope.findUnique({ where: { id: youngOrphan.id } })).not.toBeNull();
    expect(await prisma.mediaEnvelope.findUnique({ where: { id: linked.id } })).not.toBeNull();
  });

  it("an unrelated video Media does not affect a separate orphan envelope", async () => {
    const channel = await createChannel();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const orphan = await createOrphanEnvelope({ createdAt: old });
    // A normal url-media (with its own linked envelope) is unrelated to the orphan.
    await createMedia(channel.id, { mediaType: "video", sourceUrl: "https://example.com/v.mp4" });

    const result = await cleanupOrphanEnvelopes();
    // Only the mediaId-null orphan is scanned + deleted; the linked envelope is not.
    expect(result.scanned).toBe(1);
    expect(result.referenced).toBe(0);
    expect(result.deleted).toBe(1);
    expect(await prisma.mediaEnvelope.findUnique({ where: { id: orphan.id } })).toBeNull();
  });

  it("never scans a linked envelope on an article Media", async () => {
    const channel = await createChannel();
    const linked = await createLinkedEnvelope(channel.id, "article");

    const result = await cleanupOrphanEnvelopes();
    expect(result.scanned).toBe(0);
    expect(result.referenced).toBe(0);
    expect(result.deleted).toBe(0);
    expect(await prisma.mediaEnvelope.findUnique({ where: { id: linked.id } })).not.toBeNull();
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
