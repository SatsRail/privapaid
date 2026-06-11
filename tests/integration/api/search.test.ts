import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
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
import { prisma } from "@/lib/prisma";

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
    await createChannel({ name: "Cooking Show", slug: "cooking-show", active: true });
    await createChannel({ name: "Gaming Live", slug: "gaming-live", active: true });

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
    });
    await createMedia(channel.id, {
      name: "JavaScript Tutorial",
      mediaType: "video",
    });
    await createMedia(channel.id, {
      name: "Python Basics",
      mediaType: "video",
    });

    const req = buildSearchRequest("JavaScript");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const mediaResults = body.results.filter((r: { type: string }) => r.type === "media");
    expect(mediaResults).toHaveLength(1);
    expect(mediaResults[0].name).toBe("JavaScript Tutorial");
  });

  it("excludes soft-deleted channels and media — the soft-delete contract", async () => {
    const liveChannel = await createChannel({
      name: "Visible Cooking",
      slug: "visible-cooking",
      active: true,
    });
    const deletedChannel = await createChannel({
      name: "Deleted Cooking",
      slug: "deleted-cooking",
      active: true,
    });
    await prisma.channel.update({
      where: { id: deletedChannel.id },
      data: { deletedAt: new Date() },
    });

    await createMedia(liveChannel.id, { name: "Cooking Tips Live" });
    const deletedMedia = await createMedia(liveChannel.id, { name: "Cooking Tips Removed" });
    await prisma.media.update({
      where: { id: deletedMedia.id },
      data: { deletedAt: new Date() },
    });

    const req = buildSearchRequest("Cooking");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const names = body.results.map((r: { name: string }) => r.name);
    expect(names).toContain("Visible Cooking");
    expect(names).toContain("Cooking Tips Live");
    expect(names).not.toContain("Deleted Cooking");
    expect(names).not.toContain("Cooking Tips Removed");
  });

  it("respects NSFW filter", async () => {
    await createChannel({ name: "Safe Channel", slug: "safe-channel", active: true });
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
    mockConfig.nsfw = true;
    await createChannel({ name: "Safe Channel", slug: "safe-channel", active: true });
    await createChannel({ name: "NSFW Channel", slug: "nsfw-channel", active: true, nsfw: true });

    const req = buildSearchRequest("Channel");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const channelResults = body.results.filter((r: { type: string }) => r.type === "channel");
    expect(channelResults).toHaveLength(2);
  });

  it("drops media whose channel is hidden by the NSFW filter", async () => {
    const hidden = await createChannel({
      name: "Adult Channel",
      slug: "adult-channel",
      active: true,
      nsfw: true,
    });
    await createMedia(hidden.id, {
      name: "Spicy Tutorial",
      mediaType: "video",
    });

    const req = buildSearchRequest("Spicy");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const mediaResults = body.results.filter((r: { type: string }) => r.type === "media");
    expect(mediaResults).toHaveLength(0);
  });
});
