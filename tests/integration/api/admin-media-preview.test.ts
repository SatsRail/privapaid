import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));

const { requireAdminApiMock } = vi.hoisted(() => ({
  requireAdminApiMock: vi.fn().mockResolvedValue({
    id: "admin-1",
    email: "admin@test.com",
    role: "owner",
  }),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: requireAdminApiMock,
}));

import { GET } from "@/app/api/admin/media/[id]/preview/route";
import { prisma } from "@/lib/prisma";
import { createChannel } from "../../helpers/factories";

function buildReq(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/admin/media/${id}/preview`));
}

describe("GET /api/admin/media/[id]/preview", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    requireAdminApiMock.mockResolvedValue({
      id: "admin-1",
      email: "admin@test.com",
      role: "owner",
    });
  });

  it("returns 401-ish NextResponse when admin auth fails", async () => {
    requireAdminApiMock.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const id = "ckmissingfakefakefakefake";
    const res = await GET(buildReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when media does not exist", async () => {
    const id = "ckmissingfakefakefakefake";
    const res = await GET(buildReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns sourceUrl + mediaType and writes an audit entry on success", async () => {
    const channel = await createChannel();
    const media = await prisma.media.create({
      data: {
        ref: 7777,
        channelId: channel.id,
        name: "Preview Me",
        blob: { kind: "url", url: "https://example.com/sample.mp4" },
        mediaType: "video",
        position: 1,
      },
    });

    const res = await GET(buildReq(media.id), {
      params: Promise.resolve({ id: media.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_url).toBe("https://example.com/sample.mp4");
    expect(body.media_type).toBe("video");

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entry = auditMock.mock.calls[0][0];
    expect(entry.action).toBe("media.preview");
    expect(entry.actorId).toBe("admin-1");
    expect(entry.targetId).toBe(media.id);
    expect(entry.details).toEqual({ name: "Preview Me" });
  });
});
