import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";

// Mocks — MUST be before route imports
const { mockRateLimit, mockAuth, mockVerifyMacaroon } = vi.hoisted(() => ({
  mockRateLimit: vi.fn().mockResolvedValue(null),
  // Default: no session — falls through to macaroon path.
  mockAuth: vi.fn().mockResolvedValue(null),
  // Default: macaroon grants access — so existing happy-path tests stay green.
  mockVerifyMacaroon: vi.fn().mockResolvedValue({ granted: true }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/access-gate", async (importOriginal) => {
  // Keep getProductsForMedia real (it just queries MediaProduct/ChannelProduct
  // and works against the test DB) but stub the macaroon check.
  const original = await importOriginal<typeof import("@/lib/access-gate")>();
  return {
    ...original,
    verifyMacaroonAccess: mockVerifyMacaroon,
  };
});

import { POST as likeMedia } from "@/app/api/media/[id]/like/route";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Like API — POST /api/media/[id]/like", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    mockRateLimit.mockResolvedValue(null);
    mockAuth.mockResolvedValue(null);
    mockVerifyMacaroon.mockResolvedValue({ granted: true });
    vi.clearAllMocks();
  });

  async function seedMedia(overrides: Partial<{ likesCount: number }> = {}) {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-like-${nextRef()}`,
        name: "Like Channel",
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Likable Video",
        blob: { kind: "url", url: "https://example.com/like.mp4" },
        mediaType: "video",
        position: 1,
        ...overrides,
      },
    });
    // Attach a product so getProductsForMedia returns something.
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: "prod_like",
      encryptedSourceUrl: "encrypted_blob",
    });
    return { mediaId: media.id };
  }

  it("increments likesCount on action=like and returns the new value", async () => {
    const { mediaId } = await seedMedia();

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "like" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ likes_count: 1 });

    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.likesCount).toBe(1);
  });

  it("decrements likesCount on action=unlike when count > 0", async () => {
    const { mediaId } = await seedMedia({ likesCount: 3 });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "unlike" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ likes_count: 2 });
  });

  it("clamps at 0 — unlike when count is 0 stays at 0", async () => {
    const { mediaId } = await seedMedia({ likesCount: 0 });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "unlike" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ likes_count: 0 });

    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.likesCount).toBe(0);
  });

  it("returns 404 when media does not exist (like)", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const req = jsonRequest(
      `http://localhost:3000/api/media/${fakeId}/like`,
      "POST",
      { action: "like" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: fakeId }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 404 when media does not exist (unlike)", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const req = jsonRequest(
      `http://localhost:3000/api/media/${fakeId}/like`,
      "POST",
      { action: "unlike" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: fakeId }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 400 for invalid action", async () => {
    const { mediaId } = await seedMedia();
    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "love" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(400);
  });

  it("propagates rate-limit 429", async () => {
    const { mediaId } = await seedMedia();
    mockRateLimit.mockResolvedValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "like" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(429);
  });

  // ── Payment gating (mirrors the comments-route pattern) ─────────────

  it("returns 401 when neither session nor macaroon proves payment", async () => {
    const { mediaId } = await seedMedia();
    mockAuth.mockResolvedValue(null);
    mockVerifyMacaroon.mockResolvedValue({ granted: false });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "like" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required to like");

    // Counter must not have moved.
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.likesCount).toBe(0);
  });

  it("allows anonymous payer via macaroon when no session is present", async () => {
    const { mediaId } = await seedMedia();
    mockAuth.mockResolvedValue(null);
    mockVerifyMacaroon.mockResolvedValue({ granted: true });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/like`,
      "POST",
      { action: "like" }
    );
    const res = await likeMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ likes_count: 1 });
  });
});
