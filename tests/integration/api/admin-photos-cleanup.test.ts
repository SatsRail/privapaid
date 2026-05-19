import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

const { mockRequireOwnerApi, mockCleanup, mockAudit } = vi.hoisted(() => ({
  mockRequireOwnerApi: vi.fn(),
  mockCleanup: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/mongodb", () => ({ connectDB: vi.fn().mockResolvedValue(mongoose) }));
vi.mock("@/lib/auth-helpers", () => ({ requireOwnerApi: mockRequireOwnerApi }));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));
vi.mock("@/lib/photo-cleanup", () => ({
  cleanupOrphanEncryptedPhotos: mockCleanup,
  DEFAULT_ORPHAN_GRACE_MS: 60 * 60 * 1000,
}));

import { POST } from "@/app/api/admin/photos/cleanup/route";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(
    new URL("http://localhost:3000/api/admin/photos/cleanup"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
  );
}

const baseSession = { id: "admin-1", email: "admin@test.com", role: "owner" as const };

const baseResult = {
  scanned: 0,
  referenced: 0,
  orphaned: 0,
  deleted: 0,
  skippedYoung: 0,
  errors: [],
};

describe("POST /api/admin/photos/cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOwnerApi.mockResolvedValue(baseSession);
    mockCleanup.mockResolvedValue({ ...baseResult });
  });

  it("requires owner auth — delegates to requireOwnerApi", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireOwnerApi.mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const res = await POST(buildRequest({}));
    expect(res.status).toBe(403);
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it("uses default grace (1 hour) when graceSeconds is omitted", async () => {
    await POST(buildRequest({}));
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    const args = mockCleanup.mock.calls[0][0];
    expect(args.graceMs).toBe(60 * 60 * 1000);
    expect(args.dryRun).toBe(false);
  });

  it("converts graceSeconds (>=0) to graceMs", async () => {
    await POST(buildRequest({ graceSeconds: 30 }));
    expect(mockCleanup.mock.calls[0][0].graceMs).toBe(30_000);

    await POST(buildRequest({ graceSeconds: 0 }));
    expect(mockCleanup.mock.calls[1][0].graceMs).toBe(0);
  });

  it("ignores a negative graceSeconds and falls back to the default", async () => {
    await POST(buildRequest({ graceSeconds: -5 }));
    expect(mockCleanup.mock.calls[0][0].graceMs).toBe(60 * 60 * 1000);
  });

  it("ignores a non-numeric graceSeconds and falls back to the default", async () => {
    await POST(buildRequest({ graceSeconds: "abc" }));
    expect(mockCleanup.mock.calls[0][0].graceMs).toBe(60 * 60 * 1000);
  });

  it("passes dryRun through when true", async () => {
    await POST(buildRequest({ dryRun: true }));
    expect(mockCleanup.mock.calls[0][0].dryRun).toBe(true);
  });

  it("only accepts strict boolean true for dryRun (truthy strings don't count)", async () => {
    await POST(buildRequest({ dryRun: "true" }));
    expect(mockCleanup.mock.calls[0][0].dryRun).toBe(false);
  });

  it("returns the full CleanupResult plus echoed config", async () => {
    mockCleanup.mockResolvedValueOnce({
      scanned: 5,
      referenced: 3,
      orphaned: 2,
      deleted: 1,
      skippedYoung: 1,
      errors: [{ gridFsId: "abc", error: "boom" }],
    });

    const res = await POST(buildRequest({ graceSeconds: 120 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      dryRun: false,
      graceSeconds: 120,
      scanned: 5,
      referenced: 3,
      orphaned: 2,
      deleted: 1,
      skippedYoung: 1,
    });
    expect(body.data.errors).toHaveLength(1);
  });

  it("writes an audit entry when deletions happen", async () => {
    mockCleanup.mockResolvedValueOnce({
      ...baseResult,
      scanned: 2,
      orphaned: 1,
      deleted: 1,
    });
    await POST(buildRequest({}));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const entry = mockAudit.mock.calls[0][0];
    expect(entry.action).toBe("photos.cleanup");
    expect(entry.actorId).toBe("admin-1");
    expect(entry.details.deleted).toBe(1);
  });

  it("does NOT write an audit entry when nothing was deleted", async () => {
    mockCleanup.mockResolvedValueOnce({ ...baseResult, scanned: 5, referenced: 5 });
    await POST(buildRequest({}));
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("does NOT write an audit entry for dry runs", async () => {
    mockCleanup.mockResolvedValueOnce({
      ...baseResult,
      scanned: 2,
      orphaned: 2,
      deleted: 0,
    });
    await POST(buildRequest({ dryRun: true }));
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("returns 500 when the cleanup throws", async () => {
    mockCleanup.mockRejectedValueOnce(new Error("mongo broke"));
    const res = await POST(buildRequest({}));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("mongo broke");
  });

  it("tolerates a missing body and uses defaults", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/admin/photos/cleanup"),
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockCleanup.mock.calls[0][0]).toEqual({
      graceMs: 60 * 60 * 1000,
      dryRun: false,
    });
  });
});
