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

// Mock config — start with nsfw: false (use vi.hoisted to avoid TDZ in hoisted factory)
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { nsfw: false },
}));
vi.mock("@/config/instance", () => ({
  default: mockConfig,
}));

import { GET } from "@/app/api/search/route";
import { NextRequest } from "next/server";
import { createChannel, createMedia } from "../../helpers/factories";

function buildSearchRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/search?q=${encodeURIComponent(query)}`, {
    method: "GET",
  });
}

describe("GET /api/search", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    mockConfig.nsfw = false;
  });

  it("returns empty results for short query", async () => {
    const req = buildSearchRequest("a");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("returns empty results for missing query", async () => {
    const req = new NextRequest("http://localhost:3000/api/search", { method: "GET" });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("finds channels by name", async () => {
    await createChannel({ name: "Cooking Show", slug: "cooking-show", active: true, nsfw: false });
    await createChannel({ name: "Gaming Live", slug: "gaming-live", active: true, nsfw: false });

    const req = buildSearchRequest("Cooking");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].type).toBe("channel");
    expect(body.results[0].name).toBe("Cooking Show");
  });

  it("finds media by name", async () => {
    const channel = await createChannel({
      name: "Tech Channel",
      slug: "tech-channel",
      active: true,
      nsfw: false,
    });
    await createMedia(channel._id.toString(), {
      name: "JavaScript Tutorial",
      media_type: "video",
    });
    await createMedia(channel._id.toString(), {
      name: "Python Basics",
      media_type: "video",
    });

    const req = buildSearchRequest("JavaScript");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const mediaResults = body.results.filter((r: { type: string }) => r.type === "media");
    expect(mediaResults).toHaveLength(1);
    expect(mediaResults[0].name).toBe("JavaScript Tutorial");
  });

  it("respects NSFW filter", async () => {
    // config.nsfw is false — NSFW channels should be hidden
    await createChannel({ name: "Safe Channel", slug: "safe-channel", active: true, nsfw: false });
    await createChannel({ name: "NSFW Channel", slug: "nsfw-channel", active: true, nsfw: true });

    const req = buildSearchRequest("Channel");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const channelResults = body.results.filter((r: { type: string }) => r.type === "channel");
    expect(channelResults).toHaveLength(1);
    expect(channelResults[0].name).toBe("Safe Channel");
  });

  it("includes NSFW channels when config.nsfw is true", async () => {
    // Flip config — both branches of `!config.nsfw ? ...` need coverage.
    mockConfig.nsfw = true;
    await createChannel({ name: "Safe Channel", slug: "safe-channel", active: true, nsfw: false });
    await createChannel({ name: "NSFW Channel", slug: "nsfw-channel", active: true, nsfw: true });

    const req = buildSearchRequest("Channel");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const channelResults = body.results.filter((r: { type: string }) => r.type === "channel");
    expect(channelResults).toHaveLength(2);
  });

  it("drops media whose channel is hidden by the NSFW filter", async () => {
    // config.nsfw is false — media on an NSFW channel must be excluded
    // even when the media name matches. Exercises the
    // `if (!channelSlug) continue` skip branch (line 77).
    const hidden = await createChannel({
      name: "Adult Channel",
      slug: "adult-channel",
      active: true,
      nsfw: true,
    });
    await createMedia(hidden._id.toString(), {
      name: "Spicy Tutorial",
      media_type: "video",
    });

    const req = buildSearchRequest("Spicy");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const mediaResults = body.results.filter((r: { type: string }) => r.type === "media");
    expect(mediaResults).toHaveLength(0);
  });
});
