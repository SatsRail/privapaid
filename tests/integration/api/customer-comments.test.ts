import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose, { Types } from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock connectDB
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
}));

const { customerId } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Types } = require("mongoose");
  return { customerId: new Types.ObjectId() };
});

vi.mock("@/lib/auth-helpers", () => ({
  requireCustomerApi: vi.fn().mockResolvedValue({
    id: customerId.toString(),
    name: "testuser",
  }),
}));

import { NextResponse } from "next/server";
import { GET } from "@/app/api/customer/comments/route";
import { requireCustomerApi } from "@/lib/auth-helpers";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import Comment from "@/models/Comment";
import { createChannel, createMedia } from "../../helpers/factories";

describe("GET /api/customer/comments", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns empty data when customer has no comments", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("returns comments for the authenticated customer", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id), { name: "Test Video" });

    await Comment.create({
      media_id: media._id,
      customer_id: customerId,
      nickname: "testuser",
      body: "Great video!",
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].body).toBe("Great video!");
    expect(body.data[0].nickname).toBe("testuser");
    expect(body.data[0].media).toBeTruthy();
    expect(body.data[0].media.name).toBe("Test Video");
    expect(body.data[0].media.channel_slug).toBe(channel.slug);
    expect(body.data[0].media.channel_name).toBe(channel.name);
  });

  it("does not return comments from other customers", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id));
    const otherId = new Types.ObjectId();

    await Comment.create({
      media_id: media._id,
      customer_id: otherId,
      nickname: "otheruser",
      body: "Someone else's comment",
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(0);
  });

  it("returns comments sorted by created_at descending", async () => {
    const channel = await createChannel();
    const media = await createMedia(String(channel._id));

    await Comment.create({
      media_id: media._id,
      customer_id: customerId,
      nickname: "testuser",
      body: "First comment",
      created_at: new Date("2024-01-01"),
    });

    await Comment.create({
      media_id: media._id,
      customer_id: customerId,
      nickname: "testuser",
      body: "Second comment",
      created_at: new Date("2024-06-01"),
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].body).toBe("Second comment");
    expect(body.data[1].body).toBe("First comment");
  });

  it("handles comments with deleted media gracefully", async () => {
    const deletedMediaId = new Types.ObjectId();

    await Comment.create({
      media_id: deletedMediaId,
      customer_id: customerId,
      nickname: "testuser",
      body: "Comment on deleted media",
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].body).toBe("Comment on deleted media");
    expect(body.data[0].media).toBeNull();
  });

  it("returns 401 when requireCustomerApi denies access", async () => {
    vi.mocked(requireCustomerApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("renders null channel info when media has no channel populated", async () => {
    const orphanChannelId = new Types.ObjectId();
    // Insert media whose channel_id points at no real channel
    const media = await Media.collection.insertOne({
      ref: 9001,
      channel_id: orphanChannelId,
      name: "Orphan media",
      source_url: "https://example.com/o.mp4",
      media_type: "video",
      position: 1,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await Comment.create({
      media_id: media.insertedId,
      customer_id: customerId,
      nickname: "testuser",
      body: "orphan",
    });

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    const comment = body.data.find((c: { body: string }) => c.body === "orphan");
    expect(comment).toBeTruthy();
    expect(comment.media.channel_slug).toBeNull();
    expect(comment.media.channel_name).toBeNull();
  });

  // Touch Channel import so tsc doesn't strip it; also keeps mongoose connection live
  it("auxiliary: Channel model is registered", () => {
    expect(Channel.modelName).toBe("Channel");
  });
});
