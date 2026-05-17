import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
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

// Mock audit
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

// Mock customer auth — the session.id must match the DB customer _id
// Use vi.hoisted to create the ObjectId before vi.mock factories are evaluated
const { customerId } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Types } = require("mongoose");
  return { customerId: new Types.ObjectId() };
});
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireOwnerApi: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
  requireCustomerApi: vi.fn().mockResolvedValue({
    id: customerId.toString(),
    name: "testuser",
  }),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST, DELETE } from "@/app/api/customer/favorites/route";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { createCustomer, createChannel } from "../../helpers/factories";

function buildRequest(method: string, body?: unknown): NextRequest {
  const url = new URL("http://localhost:3000/api/customer/favorites");
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(url, init);
}

describe("Customer Favorites routes", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("GET returns empty favorites initially", async () => {
    await createCustomer({ _id: customerId, nickname: "favuser" });

    buildRequest("GET");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.favorite_channel_ids).toEqual([]);
  });

  it("POST adds a favorite", async () => {
    await createCustomer({ _id: customerId, nickname: "favuser" });
    const channel = await createChannel({ name: "Fav Channel", slug: "fav-channel" });

    const req = buildRequest("POST", { channel_id: channel._id.toString() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify via GET
    const getRes = await GET();
    const getBody = await getRes.json();
    expect(getBody.favorite_channel_ids).toHaveLength(1);
  });

  it("POST is idempotent (addToSet)", async () => {
    await createCustomer({ _id: customerId, nickname: "favuser" });
    const channel = await createChannel({ name: "Dup Fav", slug: "dup-fav" });
    const channelId = channel._id.toString();

    // Add twice
    await POST(buildRequest("POST", { channel_id: channelId }));
    await POST(buildRequest("POST", { channel_id: channelId }));

    const getRes = await GET();
    const getBody = await getRes.json();
    expect(getBody.favorite_channel_ids).toHaveLength(1);
  });

  it("GET returns empty array when customer record is missing", async () => {
    // No customer in DB — session id points to nothing
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.favorite_channel_ids).toEqual([]);
  });

  it("GET returns NextResponse from requireCustomerApi when unauthenticated", async () => {
    vi.mocked(requireCustomerApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("POST returns 401 when requireCustomerApi denies access", async () => {
    vi.mocked(requireCustomerApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const req = buildRequest("POST", { channel_id: "anything" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("POST returns 400 when body is invalid", async () => {
    await createCustomer({ _id: customerId, nickname: "favuser" });
    const req = buildRequest("POST", {});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("DELETE returns 401 when requireCustomerApi denies access", async () => {
    vi.mocked(requireCustomerApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const req = buildRequest("DELETE", { channel_id: "anything" });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });

  it("DELETE returns 400 when body is invalid", async () => {
    await createCustomer({ _id: customerId, nickname: "favuser" });
    const req = buildRequest("DELETE", {});
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });

  it("DELETE removes a favorite", async () => {
    const channel = await createChannel({ name: "Remove Fav", slug: "remove-fav" });
    const channelId = channel._id.toString();
    await createCustomer({
      _id: customerId,
      nickname: "favuser",
      favorite_channel_ids: [channel._id],
    });

    const req = buildRequest("DELETE", { channel_id: channelId });
    const res = await DELETE(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const getRes = await GET();
    const getBody = await getRes.json();
    expect(getBody.favorite_channel_ids).toEqual([]);
  });
});
