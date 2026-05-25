import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(undefined) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({
    satsrail: { apiUrl: "https://satsrail.com/api/v1" },
  }),
}));

// auth mock — will be overridden per test
const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

import { GET as getComments, POST as createComment } from "@/app/api/media/[id]/comments/route";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Comments API — GET /api/media/[id]/comments", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  async function seed() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-comments-${nextRef()}`,
        name: "Comments Channel",
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Commentable Video",
        sourceUrl: "https://example.com/video.mp4",
        mediaType: "video",
        position: 1,
      },
    });
    return { channelId: channel.id, mediaId: media.id };
  }

  it("returns empty comments for media with none", async () => {
    const { mediaId } = await seed();

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "GET");
    const res = await getComments(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  it("returns comments for a media item", async () => {
    const { mediaId } = await seed();
    const customer = await prisma.customer.create({
      data: {
        nickname: "commenter1",
        passwordHash: "hashed",
      },
    });

    await prisma.comment.create({
      data: {
        mediaId,
        customerId: customer.id,
        nickname: "commenter1",
        body: "Great video!",
      },
    });
    await prisma.comment.create({
      data: {
        mediaId,
        customerId: customer.id,
        nickname: "commenter1",
        body: "Second comment",
      },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "GET");
    const res = await getComments(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].body).toBeDefined();
    expect(body[0].customer.nickname).toBe("commenter1");
  });
});

describe("Comments API — POST /api/media/[id]/comments", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  async function seedWithProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-post-comments-${nextRef()}`,
        name: "Post Comments Channel",
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Paid Video",
        sourceUrl: "https://example.com/paid.mp4",
        mediaType: "video",
        position: 1,
      },
    });

    const mp = await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_abc",
        encryptedSourceUrl: "encrypted_blob",
      },
    });

    return { channelId: channel.id, mediaId: media.id, productId: mp.satsrailProductId };
  }

  it("creates a comment from authenticated customer with purchase", async () => {
    const { mediaId, productId } = await seedWithProduct();

    const customer = await prisma.customer.create({
      data: {
        nickname: "buyer1",
        passwordHash: "hashed",
        purchases: {
          create: [{
            satsrailOrderId: "ord_1",
            satsrailProductId: productId,
          }],
        },
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "buyer1", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "Love this content!",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    const resBody = await res.json();

    expect(res.status).toBe(201);
    expect(resBody.body).toBe("Love this content!");
    expect(resBody.customer.nickname).toBe("buyer1");

    // Verify commentsCount incremented
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.commentsCount).toBe(1);
  });

  it("returns 401 without purchase or macaroon", async () => {
    const { mediaId } = await seedWithProduct();

    const customer = await prisma.customer.create({
      data: {
        nickname: "nopurchase",
        passwordHash: "hashed",
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "nopurchase", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "Can't comment without paying",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    const resBody = await res.json();

    expect(res.status).toBe(401);
    expect(resBody.error).toBe("Payment required to comment");
  });

  it("returns 400 for invalid body (empty comment)", async () => {
    const { mediaId, productId } = await seedWithProduct();

    const customer = await prisma.customer.create({
      data: {
        nickname: "buyer2",
        passwordHash: "hashed",
        purchases: {
          create: [{
            satsrailOrderId: "ord_2",
            satsrailProductId: productId,
          }],
        },
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "buyer2", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent media", async () => {
    const fakeId = "ckmissingfakefakefakefake";

    const customer = await prisma.customer.create({
      data: {
        nickname: "ghost",
        passwordHash: "hashed",
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "ghost", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${fakeId}/comments`, "POST", {
      body: "This media doesn't exist",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: fakeId }) });
    const resBody = await res.json();

    expect(res.status).toBe(404);
    expect(resBody.error).toBe("Media not found");
  });

  it("returns the rate-limit response when limit is hit", async () => {
    const { mediaId } = await seedWithProduct();
    const { rateLimit } = await import("@/lib/rate-limit");
    const { NextResponse } = await import("next/server");
    vi.mocked(rateLimit).mockResolvedValueOnce(
      NextResponse.json({ error: "Too Many Requests" }, { status: 429 })
    );
    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "rate limited",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(429);
  });

  it("returns 400 when validation fails (missing body)", async () => {
    const { mediaId } = await seedWithProduct();
    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {});
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(400);
  });

  it("authenticated path ignores submittedNickname (anti-impersonation)", async () => {
    const { mediaId, productId } = await seedWithProduct();

    const customer = await prisma.customer.create({
      data: {
        nickname: "realname",
        passwordHash: "hashed",
        purchases: {
          create: [{
            satsrailOrderId: "ord_n",
            satsrailProductId: productId,
          }],
        },
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "realname", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "Hi there",
      // Tries to impersonate someone else; must be ignored.
      nickname: "aliasName",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(201);
    expect((await res.json()).customer.nickname).toBe("realname");
  });
});

describe("Comments API — GET fallback nickname rendering", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  it("falls back to 'Anonymous' when neither nickname nor populated customer is available", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-anon-${nextRef()}`,
        name: "Anon Channel",
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Anon Video",
        sourceUrl: "https://example.com/a.mp4",
        mediaType: "video",
        position: 1,
      },
    });

    // Create with blank nickname to simulate the legacy case
    await prisma.comment.create({
      data: {
        mediaId: media.id,
        nickname: "",
        body: "lonely comment",
      },
    });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${media.id}/comments`,
      "GET"
    );
    const res = await getComments(req, {
      params: Promise.resolve({ id: media.id }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].customer.nickname).toBe("Anonymous");
  });

  it("uses customer.nickname populated via customerId when comment.nickname is blank", async () => {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-pop-${nextRef()}`,
        name: "Populated Channel",
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Pop Video",
        sourceUrl: "https://example.com/p.mp4",
        mediaType: "video",
        position: 1,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        nickname: "populated",
        passwordHash: "hashed",
      },
    });

    await prisma.comment.create({
      data: {
        mediaId: media.id,
        customerId: customer.id,
        nickname: "",
        body: "from customer",
      },
    });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${media.id}/comments`,
      "GET"
    );
    const res = await getComments(req, {
      params: Promise.resolve({ id: media.id }),
    });
    const body = await res.json();
    expect(body[0].customer.nickname).toBe("populated");
  });
});
