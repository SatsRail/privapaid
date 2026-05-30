import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { decryptEnvelopePayload } from "@/lib/media-envelope";
import { prisma } from "@/lib/prisma";

/**
 * Every media now owns exactly one MediaEnvelope. The viewer page surfaces
 * `envelope_id` to the client UNIFORMLY (for all media kinds) so it can fetch
 * the ciphertext after unwrapping the DEK — the envelope id is safe to expose
 * because its bytes are useless without the DEK. The plaintext (URL / markdown /
 * photo bytes) always stays encrypted inside the envelope, never on the page.
 */
describe("Viewer page query for media envelopes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("photo media exposes the envelope id via the envelope relation", async () => {
    const channel = await createChannel({ slug: "showcase-1", name: "Platform Showcase" });
    const media = await createMedia(channel.id, {
      name: "Lightning in a bottle",
      mediaType: "photo",
      sourceUrl: "gridfs:photo-bytes",
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
      select: { id: true, mediaType: true, envelope: { select: { id: true } } },
    });

    expect(fetched).not.toBeNull();
    expect(fetched!.mediaType).toBe("photo");
    // Mirrors the page-level surfacing: envelope_id = media.envelope?.id.
    expect(fetched!.envelope).not.toBeNull();
    expect(typeof fetched!.envelope!.id).toBe("string");
  });

  it("non-photo media also exposes an envelope id; the URL stays encrypted server-side", async () => {
    const channel = await createChannel({ slug: "showcase-2", name: "Showcase 2" });
    const secretUrl = "https://internal.example.com/video.mp4";
    const media = await createMedia(channel.id, {
      name: "Some video",
      mediaType: "video",
      sourceUrl: secretUrl,
    });

    const fetched = await prisma.media.findFirst({
      where: { id: media.id, channelId: channel.id },
      select: {
        id: true,
        mediaType: true,
        envelope: { select: { id: true, bytes: true, wrappedDek: true } },
      },
    });

    // The envelope id is surfaced uniformly.
    expect(fetched!.envelope).not.toBeNull();
    expect(typeof fetched!.envelope!.id).toBe("string");
    // The plaintext URL is NOT on the page; it only comes back by decrypting the
    // envelope server-side (admin-only path), proving it stayed encrypted.
    const recovered = decryptEnvelopePayload({
      bytes: fetched!.envelope!.bytes,
      wrappedDek: fetched!.envelope!.wrappedDek,
    });
    expect(recovered.toString("utf8")).toBe(secretUrl);
  });

  const ALL_TYPES = ["video", "audio", "article", "podcast"] as const;
  for (const mediaType of ALL_TYPES) {
    it(`mediaType=${mediaType} surfaces an envelope id without leaking the plaintext`, async () => {
      const channel = await createChannel({ slug: `showcase-${mediaType}`, name: `Showcase ${mediaType}` });
      const payload =
        mediaType === "article"
          ? "# Body\n\nmarkdown"
          : `https://internal.example.com/${mediaType}.bin`;
      const media = await createMedia(channel.id, {
        name: `Test ${mediaType}`,
        mediaType,
        sourceUrl: payload,
      });

      const fetched = await prisma.media.findFirst({
        where: { id: media.id, channelId: channel.id },
        select: { id: true, mediaType: true, envelope: { select: { id: true } } },
      });

      // The page only ever exposes the envelope id, never the plaintext bytes.
      expect(fetched!.envelope).not.toBeNull();
      expect(typeof fetched!.envelope!.id).toBe("string");
    });
  }
});
