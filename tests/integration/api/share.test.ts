import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

const { mockRateLimit } = vi.hoisted(() => ({
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

import { POST as shareMedia } from "@/app/api/media/[id]/share/route";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function postRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), { method: "POST" });
}

describe("Share API — POST /api/media/[id]/share", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    mockRateLimit.mockResolvedValue(null);
    vi.clearAllMocks();
  });

  async function seedMedia(overrides: Partial<{ sharesCount: number }> = {}) {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-share-${nextRef()}`,
        name: "Share Channel",
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Shareable Video",
        blob: { kind: "url", url: "https://example.com/share.mp4" },
        mediaType: "video",
        position: 1,
        ...overrides,
      },
    });
    return { mediaId: media.id };
  }

  it("increments sharesCount and returns the new value", async () => {
    const { mediaId } = await seedMedia();
    const req = postRequest(`http://localhost:3000/api/media/${mediaId}/share`);
    const res = await shareMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ shares_count: 1 });

    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.sharesCount).toBe(1);
  });

  it("increments from an existing positive count", async () => {
    const { mediaId } = await seedMedia({ sharesCount: 7 });
    const req = postRequest(`http://localhost:3000/api/media/${mediaId}/share`);
    const res = await shareMedia(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ shares_count: 8 });
  });

  it("returns 404 when media does not exist", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const req = postRequest(`http://localhost:3000/api/media/${fakeId}/share`);
    const res = await shareMedia(req, { params: Promise.resolve({ id: fakeId }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("propagates rate-limit 429", async () => {
    const { mediaId } = await seedMedia();
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );
    const req = postRequest(`http://localhost:3000/api/media/${mediaId}/share`);
    const res = await shareMedia(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(429);
  });
});
