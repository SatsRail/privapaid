import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";

// ── Hoisted mocks ──────────────────────────────────────────────────
// Comments are gated behind macaroon-verified payment access. We mock the
// access-gate so we can exercise both the granted and the denied branches
// without standing up a full SatsRail roundtrip.
const { mockGetProductsForMedia, mockVerifyMacaroonAccess, mockRateLimit } =
  vi.hoisted(() => ({
    mockGetProductsForMedia: vi.fn(),
    mockVerifyMacaroonAccess: vi.fn(),
    mockRateLimit: vi.fn(),
  }));

vi.mock("@/lib/access-gate", () => ({
  getProductsForMedia: (...args: unknown[]) => mockGetProductsForMedia(...args),
  verifyMacaroonAccess: (...args: unknown[]) => mockVerifyMacaroonAccess(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/media/[id]/comments/route";
import { prisma } from "@/lib/prisma";

function buildPostRequest(mediaId: string, body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(
    new URL(`http://localhost:3000/api/media/${mediaId}/comments`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return [req, { params: Promise.resolve({ id: mediaId }) }];
}

function buildGetRequest(mediaId: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(
    new URL(`http://localhost:3000/api/media/${mediaId}/comments`),
    { method: "GET" }
  );
  return [req, { params: Promise.resolve({ id: mediaId }) }];
}

describe("Media comments API", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue(null);
    mockGetProductsForMedia.mockResolvedValue([{ productId: "prod_1" }]);
    mockVerifyMacaroonAccess.mockResolvedValue({ granted: true });
  });

  describe("GET", () => {
    it("returns comments newest first, mapping mediaId → media_id", async () => {
      const channel = await createChannel();
      const media = await createMedia(channel.id);
      const older = await prisma.comment.create({
        data: { mediaId: media.id, body: "older" },
      });
      // Tiny delay so createdAt sort is unambiguous on machines with
      // millisecond-resolution clocks.
      await new Promise((r) => setTimeout(r, 5));
      const newer = await prisma.comment.create({
        data: { mediaId: media.id, body: "newer" },
      });

      const [req, ctx] = buildGetRequest(media.id);
      const res = await GET(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].body).toBe("newer");
      expect(body.data[0].id).toBe(newer.id);
      expect(body.data[0].media_id).toBe(media.id);
      expect(body.data[1].body).toBe("older");
      expect(body.data[1].id).toBe(older.id);
    });

    it("returns an empty array when the media has no comments", async () => {
      const channel = await createChannel();
      const media = await createMedia(channel.id);

      const [req, ctx] = buildGetRequest(media.id);
      const res = await GET(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toEqual([]);
    });
  });

  describe("POST", () => {
    it("creates a comment and increments commentsCount when access is granted", async () => {
      const channel = await createChannel();
      const media = await createMedia(channel.id);

      const [req, ctx] = buildPostRequest(media.id, { body: "great video" });
      const res = await POST(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.body).toBe("great video");
      expect(body.media_id).toBe(media.id);

      const fresh = await prisma.media.findUnique({ where: { id: media.id } });
      expect(fresh!.commentsCount).toBe(1);

      const all = await prisma.comment.findMany({ where: { mediaId: media.id } });
      expect(all).toHaveLength(1);
    });

    it("returns 401 when the macaroon doesn't grant access", async () => {
      // The whole point of gating comments behind macaroons: anonymous
      // visitors who haven't paid can't pollute the comment thread.
      mockVerifyMacaroonAccess.mockResolvedValueOnce({ granted: false });

      const channel = await createChannel();
      const media = await createMedia(channel.id);

      const [req, ctx] = buildPostRequest(media.id, { body: "no pay no say" });
      const res = await POST(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe("Payment required to comment");
      expect(await prisma.comment.count({ where: { mediaId: media.id } })).toBe(0);
    });

    it("returns 404 when the media doesn't exist", async () => {
      const [req, ctx] = buildPostRequest("cm_nonexistent_id_123", { body: "hi" });
      const res = await POST(req, ctx);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe("Media not found");
    });

    it("returns the rate-limit response without ever consulting the DB", async () => {
      const { NextResponse } = await import("next/server");
      mockRateLimit.mockResolvedValueOnce(
        NextResponse.json({ error: "Too many requests" }, { status: 429 })
      );

      const [req, ctx] = buildPostRequest("cm_anything", { body: "spam" });
      const res = await POST(req, ctx);
      expect(res.status).toBe(429);

      // The route returns early; access-gate and validate should not fire.
      expect(mockGetProductsForMedia).not.toHaveBeenCalled();
      expect(mockVerifyMacaroonAccess).not.toHaveBeenCalled();
    });

    it("returns 400 when the body is missing", async () => {
      const channel = await createChannel();
      const media = await createMedia(channel.id);

      const [req, ctx] = buildPostRequest(media.id, {});
      const res = await POST(req, ctx);
      expect(res.status).toBe(400);
    });
  });
});
