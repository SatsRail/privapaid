import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { createMedia, createChannel } from "../../helpers/factories";
import Media from "@/models/Media";

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
    const media = await createMedia(channel._id.toString());
    expect(media.name).toBe("Test Media");
    expect(media.channel_id.toString()).toBe(channel._id.toString());
    expect(media.source_url).toBe("https://example.com/video.mp4");
    expect(media.media_type).toBe("video");
  });

  it("sets default values", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel._id.toString());
    expect(media.description).toBe("");
    expect(media.thumbnail_url).toBe("");
    expect(media.position).toBe(0);
    expect(media.comments_count).toBe(0);
    expect(media.flags_count).toBe(0);
    expect(media.deleted_at).toBeNull();
  });

  it("validates media_type enum", async () => {
    const channel = await createChannel();
    await expect(
      createMedia(channel._id.toString(), { media_type: "invalid_type" })
    ).rejects.toThrow();
  });

  it("accepts all valid media types", async () => {
    const channel = await createChannel();
    const types = ["video", "audio", "article", "photo", "podcast"] as const;
    for (const type of types) {
      const media = await createMedia(channel._id.toString(), {
        media_type: type,
        ref: Math.floor(Math.random() * 1000000),
      });
      expect(media.media_type).toBe(type);
    }
  });

  it("requires channel_id", async () => {
    await expect(
      Media.create({ name: "No Channel", source_url: "https://example.com", media_type: "video", ref: 99999 })
    ).rejects.toThrow();
  });

  it("queries by channel_id", async () => {
    const ch1 = await createChannel({ slug: "ch-1" });
    const ch2 = await createChannel({ slug: "ch-2" });
    await createMedia(ch1._id.toString(), { name: "Media 1" });
    await createMedia(ch1._id.toString(), { name: "Media 2" });
    await createMedia(ch2._id.toString(), { name: "Media 3" });

    const ch1Media = await Media.find({ channel_id: ch1._id });
    expect(ch1Media).toHaveLength(2);
  });
});
