import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";

vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
}));

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
import Media from "@/models/Media";

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
    const id = new mongoose.Types.ObjectId().toString();
    const res = await GET(buildReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when media does not exist", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const res = await GET(buildReq(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns source_url + media_type and writes an audit entry on success", async () => {
    const media = await Media.create({
      ref: 7777,
      channel_id: new mongoose.Types.ObjectId(),
      name: "Preview Me",
      source_url: "https://example.com/sample.mp4",
      media_type: "video",
      position: 1,
    });

    const res = await GET(buildReq(media._id.toString()), {
      params: Promise.resolve({ id: media._id.toString() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_url).toBe("https://example.com/sample.mp4");
    expect(body.media_type).toBe("video");

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entry = auditMock.mock.calls[0][0];
    expect(entry.action).toBe("media.preview");
    expect(entry.actorId).toBe("admin-1");
    expect(entry.targetId).toBe(media._id.toString());
    expect(entry.details).toEqual({ name: "Preview Me" });
  });
});
