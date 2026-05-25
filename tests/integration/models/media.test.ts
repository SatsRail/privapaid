import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMedia, createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Media model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates media with required fields", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    expect(media.name).toBe("Test Media");
    expect(media.channelId).toBe(channel.id);
    expect(media.blob).toEqual({ kind: "url", url: "https://example.com/video.mp4" });
    expect(media.mediaType).toBe("video");
  });

  it("sets default values", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    expect(media.description).toBe("");
    expect(media.thumbnailUrl).toBe("");
    expect(media.position).toBe(0);
    expect(media.deletedAt).toBeNull();
  });

  it("accepts all valid media types", async () => {
    const channel = await createChannel();
    const types = ["video", "audio", "article", "photo", "podcast"] as const;
    for (const type of types) {
      const media = await createMedia(channel.id, {
        mediaType: type,
        ref: Math.floor(Math.random() * 1_000_000),
      });
      expect(media.mediaType).toBe(type);
    }
  });

  it("queries by channelId", async () => {
    const ch1 = await createChannel({ slug: "ch-1" });
    const ch2 = await createChannel({ slug: "ch-2" });
    await createMedia(ch1.id, { name: "Media 1" });
    await createMedia(ch1.id, { name: "Media 2" });
    await createMedia(ch2.id, { name: "Media 3" });

    const ch1Media = await prisma.media.findMany({ where: { channelId: ch1.id } });
    expect(ch1Media).toHaveLength(2);
  });
});
