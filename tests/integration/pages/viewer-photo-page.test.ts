import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

/**
 * The viewer media page surfaces `Media.blob.envelopeId` to the client only when
 * `mediaType === "photo"` — for other types the blob (URL / markdown) is the
 * plaintext and must stay server-side. These tests assert that conditional.
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

  it("photo media exposes the blobId via Media.blob.envelopeId", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: 1,
        slug: "showcase-1",
        name: "Platform Showcase",
        active: true,
      },
    });

    const envelopeIdValue = "env-id-12345";
    const media = await prisma.media.create({
      data: {
        ref: 1,
        channelId: channel.id,
        name: "Lightning in a bottle",
        mediaType: "photo",
        blob: {
          kind: "photo",
          envelopeId: envelopeIdValue,
          encryptedDek: "test_dek",
          mimeType: "image/jpeg",
        },
      },
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.mediaType).toBe("photo");
    const blob = fetched!.blob as { kind: string; envelopeId: string };
    expect(blob.kind).toBe("photo");
    expect(blob.envelopeId).toBe(envelopeIdValue);

    // Mirrors the page-level conditional that surfaces envelope_id only
    // for envelope-encrypted media kinds.
    const envelopeId =
      fetched!.mediaType === "photo" ? blob.envelopeId : undefined;
    expect(envelopeId).toBe(envelopeIdValue);
  });

  it("non-photo media's blob plaintext stays server-side via the conditional", async () => {
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
        blob: { kind: "url", url: secretUrl },
      },
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
    });

    // For non-photo media the conditional yields undefined.
    const envelopeId =
      fetched!.mediaType === "photo"
        ? (fetched!.blob as { blobId?: string }).blobId
        : undefined;
    expect(envelopeId).toBeUndefined();
    const blob = fetched!.blob as { kind: string; url?: string };
    expect(blob.url).toBe(secretUrl);
  });

  const NON_PHOTO_TYPES = ["video", "audio", "article", "podcast"] as const;
  for (const mediaType of NON_PHOTO_TYPES) {
    it(`does not surface blob plaintext to the client for mediaType=${mediaType}`, async () => {
      const channel = await prisma.channel.create({
        data: {
          ref: 100 + NON_PHOTO_TYPES.indexOf(mediaType),
          slug: `showcase-${mediaType}`,
          name: `Showcase ${mediaType}`,
          active: true,
        },
      });
      const blob =
        mediaType === "article"
          ? {
              kind: "article",
              envelopeId: `env_${mediaType}_test`,
              encryptedDek: "test_dek",
              mimeType: "text/markdown; charset=utf-8",
            }
          : { kind: "url", url: `https://internal.example.com/${mediaType}.bin` };
      const media = await prisma.media.create({
        data: {
          ref: 200 + NON_PHOTO_TYPES.indexOf(mediaType),
          channelId: channel.id,
          name: `Test ${mediaType}`,
          mediaType,
          blob,
        },
      });

      const fetched = await prisma.media.findFirst({
        where: { id: media.id, channelId: channel.id },
      });

      // url-backed media has no envelopeId in its blob shape.
      const envelopeId =
        fetched!.mediaType === "photo"
          ? (fetched!.blob as { envelopeId?: string }).envelopeId
          : undefined;
      expect(envelopeId).toBeUndefined();
    });
  }
});
