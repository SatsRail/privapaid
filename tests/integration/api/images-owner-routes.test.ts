import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

import { GET as getMediaThumbnail } from "@/app/api/images/media-thumbnail/[id]/route";
import { GET as getChannelAvatar } from "@/app/api/images/channel/[id]/route";

// These two routes serve owner-row byte columns (Media.thumbnailBytes,
// Channel.profileImageBytes) — distinct from the generic PreviewImage store
// that /api/images/[id] reads. No auth: image bytes are public once a row
// exists, same as the generic route.

let refCounter = 1;
function nextRef(): number {
  return refCounter++;
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("Owner-byte image routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  async function seedChannel(overrides: Record<string, unknown> = {}): Promise<string> {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `test-channel-${nextRef()}`,
        name: "Test Channel",
        mediaCount: 0,
        ...overrides,
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

  describe("GET /api/images/media-thumbnail/[id]", () => {
    it("serves the thumbnail bytes with the stored MIME type", async () => {
      const chId = await seedChannel();
      const bytes = Buffer.from("thumbnail-bytes");
      const mediaId = await seedMedia(chId, {
        thumbnailBytes: bytes,
        thumbnailMimeType: "image/webp",
      });

      const res = await getMediaThumbnail(
        makeRequest(`http://localhost:3000/api/images/media-thumbnail/${mediaId}`),
        params(mediaId)
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/webp");
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable"
      );
      expect(res.headers.get("ETag")).toBe(`"${mediaId}"`);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
    });

    it("falls back to octet-stream when MIME type is null", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId, {
        thumbnailBytes: Buffer.from("x"),
        thumbnailMimeType: null,
      });

      const res = await getMediaThumbnail(
        makeRequest(`http://localhost:3000/api/images/media-thumbnail/${mediaId}`),
        params(mediaId)
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    });

    it("returns 404 when the media has no thumbnail bytes", async () => {
      const chId = await seedChannel();
      const mediaId = await seedMedia(chId); // no thumbnailBytes

      const res = await getMediaThumbnail(
        makeRequest(`http://localhost:3000/api/images/media-thumbnail/${mediaId}`),
        params(mediaId)
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 when the media row does not exist", async () => {
      const res = await getMediaThumbnail(
        makeRequest("http://localhost:3000/api/images/media-thumbnail/does-not-exist"),
        params("does-not-exist")
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for an empty id", async () => {
      const res = await getMediaThumbnail(
        makeRequest("http://localhost:3000/api/images/media-thumbnail/"),
        params("")
      );

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/images/channel/[id]", () => {
    it("serves the avatar bytes with the stored MIME type", async () => {
      const bytes = Buffer.from("avatar-bytes");
      const chId = await seedChannel({
        profileImageBytes: bytes,
        profileImageMimeType: "image/png",
      });

      const res = await getChannelAvatar(
        makeRequest(`http://localhost:3000/api/images/channel/${chId}`),
        params(chId)
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable"
      );
      expect(res.headers.get("ETag")).toBe(`"${chId}"`);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
    });

    it("returns 404 when the channel has no avatar bytes", async () => {
      const chId = await seedChannel(); // no profileImageBytes

      const res = await getChannelAvatar(
        makeRequest(`http://localhost:3000/api/images/channel/${chId}`),
        params(chId)
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 when the channel row does not exist", async () => {
      const res = await getChannelAvatar(
        makeRequest("http://localhost:3000/api/images/channel/does-not-exist"),
        params("does-not-exist")
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for an empty id", async () => {
      const res = await getChannelAvatar(
        makeRequest("http://localhost:3000/api/images/channel/"),
        params("")
      );

      expect(res.status).toBe(400);
    });
  });
});
