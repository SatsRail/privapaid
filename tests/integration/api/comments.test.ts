import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(undefined) }),
}));
vi.mock("@/lib/mongodb", () => ({ connectDB: vi.fn().mockImplementation(async () => mongoose) }));
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
import Media from "@/models/Media";
import Channel from "@/models/Channel";
import Customer from "@/models/Customer";
import Comment from "@/models/Comment";
import MediaProduct from "@/models/MediaProduct";

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Comments API — GET /api/media/[id]/comments", () => {
  let channelId: string;
  let mediaId: string;

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
    const channel = await Channel.create({
      ref: 1,
      slug: "ch-comments",
      name: "Comments Channel",
    });
    channelId = String(channel._id);

    const media = await Media.create({
      ref: 200,
      channel_id: channelId,
      name: "Commentable Video",
      source_url: "https://example.com/video.mp4",
      media_type: "video",
      position: 1,
    });
    mediaId = String(media._id);
    return { channelId, mediaId };
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
    const customer = await Customer.create({
      nickname: "commenter1",
      password_hash: "hashed",
    });

    await Comment.create({
      media_id: mediaId,
      customer_id: customer._id,
      nickname: "commenter1",
      body: "Great video!",
    });
    await Comment.create({
      media_id: mediaId,
      customer_id: customer._id,
      nickname: "commenter1",
      body: "Second comment",
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
  let channelId: string;
  let mediaId: string;

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
    const channel = await Channel.create({
      ref: 2,
      slug: "ch-post-comments",
      name: "Post Comments Channel",
    });
    channelId = String(channel._id);

    const media = await Media.create({
      ref: 201,
      channel_id: channelId,
      name: "Paid Video",
      source_url: "https://example.com/paid.mp4",
      media_type: "video",
      position: 1,
    });
    mediaId = String(media._id);

    const mp = await MediaProduct.create({
      media_id: mediaId,
      satsrail_product_id: "prod_abc",
      encrypted_source_url: "encrypted_blob",
    });

    return { channelId, mediaId, productId: mp.satsrail_product_id };
  }

  it("creates a comment from authenticated customer with purchase", async () => {
    const { mediaId, productId } = await seedWithProduct();

    const customer = await Customer.create({
      nickname: "buyer1",
      password_hash: "hashed",
      purchases: [
        {
          satsrail_order_id: "ord_1",
          satsrail_product_id: productId,
          purchased_at: new Date(),
        },
      ],
    });

    mockAuth.mockResolvedValue({
      user: { id: String(customer._id), name: "buyer1", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "Love this content!",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    const resBody = await res.json();

    expect(res.status).toBe(201);
    expect(resBody.body).toBe("Love this content!");
    expect(resBody.customer.nickname).toBe("buyer1");

    // Verify comments_count incremented
    const media = await Media.findById(mediaId);
    expect(media!.comments_count).toBe(1);
  });

  it("returns 401 without purchase or macaroon", async () => {
    const { mediaId } = await seedWithProduct();

    const customer = await Customer.create({
      nickname: "nopurchase",
      password_hash: "hashed",
      purchases: [],
    });

    mockAuth.mockResolvedValue({
      user: { id: String(customer._id), name: "nopurchase", role: "customer" },
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

    const customer = await Customer.create({
      nickname: "buyer2",
      password_hash: "hashed",
      purchases: [
        {
          satsrail_order_id: "ord_2",
          satsrail_product_id: productId,
          purchased_at: new Date(),
        },
      ],
    });

    mockAuth.mockResolvedValue({
      user: { id: String(customer._id), name: "buyer2", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/comments`, "POST", {
      body: "",
    });
    const res = await createComment(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent media", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();

    const customer = await Customer.create({
      nickname: "ghost",
      password_hash: "hashed",
    });

    mockAuth.mockResolvedValue({
      user: { id: String(customer._id), name: "ghost", role: "customer" },
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

    const customer = await Customer.create({
      nickname: "realname",
      password_hash: "hashed",
      purchases: [
        {
          satsrail_order_id: "ord_n",
          satsrail_product_id: productId,
          purchased_at: new Date(),
        },
      ],
    });

    mockAuth.mockResolvedValue({
      user: { id: String(customer._id), name: "realname", role: "customer" },
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
  let channelId: string;
  let mediaId: string;

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
    const channel = await Channel.create({
      ref: 99,
      slug: "ch-anon",
      name: "Anon Channel",
    });
    channelId = String(channel._id);

    const media = await Media.create({
      ref: 555,
      channel_id: channelId,
      name: "Anon Video",
      source_url: "https://example.com/a.mp4",
      media_type: "video",
      position: 1,
    });
    mediaId = String(media._id);

    // Insert directly bypassing schema validation (nickname is normally required)
    await Comment.collection.insertOne({
      media_id: new mongoose.Types.ObjectId(mediaId),
      body: "lonely comment",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${mediaId}/comments`,
      "GET"
    );
    const res = await getComments(req, {
      params: Promise.resolve({ id: mediaId }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].customer.nickname).toBe("Anonymous");
  });

  it("uses customer.nickname populated via customer_id when comment.nickname is blank", async () => {
    const channel = await Channel.create({
      ref: 100,
      slug: "ch-pop",
      name: "Populated Channel",
    });
    const media = await Media.create({
      ref: 556,
      channel_id: String(channel._id),
      name: "Pop Video",
      source_url: "https://example.com/p.mp4",
      media_type: "video",
      position: 1,
    });
    const customer = await Customer.create({
      nickname: "populated",
      password_hash: "hashed",
    });

    await Comment.collection.insertOne({
      media_id: media._id,
      customer_id: customer._id,
      body: "from customer",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const req = jsonRequest(
      `http://localhost:3000/api/media/${media._id}/comments`,
      "GET"
    );
    const res = await getComments(req, {
      params: Promise.resolve({ id: String(media._id) }),
    });
    const body = await res.json();
    expect(body[0].customer.nickname).toBe("populated");
  });
});
