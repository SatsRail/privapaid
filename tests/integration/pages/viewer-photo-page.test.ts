import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

/**
 * Regression test for the "Payment received, couldn't unlock" bug.
 *
 * The viewer page surfaces `media.sourceUrl` to the client as `photo_gridfs_id`
 * ONLY for photo media. If the underlying query drops `sourceUrl` the client
 * receives `photoGridFsId={undefined}` and PaymentWall throws after payment.
 */
describe("Viewer page query for photo media", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns sourceUrl (blob pointer) for photo media", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: 1,
        slug: "showcase",
        name: "Platform Showcase",
        active: true,
      },
    });

    const blobId = "blob-id-12345";
    const media = await prisma.media.create({
      data: {
        ref: 1,
        channelId: channel.id,
        name: "Lightning in a bottle",
        mediaType: "photo",
        sourceUrl: blobId,
      },
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.mediaType).toBe("photo");
    expect(fetched!.sourceUrl).toBe(blobId);

    const photoGridFsId =
      fetched!.mediaType === "photo" ? fetched!.sourceUrl : undefined;
    expect(photoGridFsId).toBe(blobId);
  });

  it("non-photo media's sourceUrl stays server-side via the conditional", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: 2,
        slug: "showcase-2",
        name: "Showcase 2",
        active: true,
      },
    });

    const secretUrl = "https://internal.example.com/video.mp4";
    const media = await prisma.media.create({
      data: {
        ref: 3,
        channelId: channel.id,
        name: "Some video",
        mediaType: "video",
        sourceUrl: secretUrl,
      },
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
    });

    const photoGridFsId =
      fetched!.mediaType === "photo" ? fetched!.sourceUrl : undefined;
    expect(photoGridFsId).toBeUndefined();
    expect(fetched!.sourceUrl).toBe(secretUrl);
  });

  const NON_PHOTO_TYPES = ["video", "audio", "article", "podcast"] as const;
  for (const mediaType of NON_PHOTO_TYPES) {
    it(`does not surface sourceUrl to the client for mediaType=${mediaType}`, async () => {
      const channel = await prisma.channel.create({
        data: {
          ref: 100 + NON_PHOTO_TYPES.indexOf(mediaType),
          slug: `showcase-${mediaType}`,
          name: `Showcase ${mediaType}`,
          active: true,
        },
      });
      const media = await prisma.media.create({
        data: {
          ref: 200 + NON_PHOTO_TYPES.indexOf(mediaType),
          channelId: channel.id,
          name: `Test ${mediaType}`,
          mediaType,
          sourceUrl: `https://internal.example.com/${mediaType}.bin`,
        },
      });

      const fetched = await prisma.media.findFirst({
        where: { id: media.id, channelId: channel.id },
      });

      const photoGridFsId =
        fetched!.mediaType === "photo" ? fetched!.sourceUrl : undefined;
      expect(photoGridFsId).toBeUndefined();
    });
  }
});
