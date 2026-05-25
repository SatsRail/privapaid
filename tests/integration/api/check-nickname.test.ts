import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createCustomer } from "../../helpers/factories";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/customer/check-nickname/route";

function buildRequest(nickname?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/customer/check-nickname");
  if (nickname !== undefined) {
    url.searchParams.set("nickname", nickname);
  }
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/customer/check-nickname", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns available true for a nickname not in use", async () => {
    const res = await GET(buildRequest("freshname"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
  });

  it("returns available false for a taken nickname", async () => {
    await createCustomer({ nickname: "takenuser" });

    const res = await GET(buildRequest("takenuser"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it("returns available false for case-insensitive match", async () => {
    await createCustomer({ nickname: "TestUser" });

    const res = await GET(buildRequest("testuser"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it("returns available false when nickname is missing", async () => {
    const res = await GET(buildRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it("returns available false when nickname is too short", async () => {
    const res = await GET(buildRequest("a"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it("returns available true for a 2-character nickname", async () => {
    const res = await GET(buildRequest("ab"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
  });
});
