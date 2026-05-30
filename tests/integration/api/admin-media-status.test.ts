import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

/**
 * Owner-only manual reset of the Part B decrypt-error flag. The flag normally
 * auto-clears on re-encrypt; this route is the manual override ("Mark resolved"
 * on the edit page). It ONLY flips error → ok — it can never set `error`, which
 * is server-confirmed exclusively via /api/media/[id]/report-error.
 *
 * We exercise the real `requireOwnerApi` gate by mocking `@/lib/auth` (same
 * pattern as the re-encrypt route test), so 401/403 reflect genuine auth logic.
 */
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "@/app/api/admin/media/[id]/status/route";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

const OWNER_SESSION = {
  user: { id: "admin-1", email: "admin@test.com", name: "Admin", type: "admin", role: "owner" },
};

let refSeed = 7000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/admin/media/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Admin media status reset — POST /api/admin/media/[id]/status", () => {
  beforeAll(async () => {
    await setupTestDB();
    mockAuth.mockResolvedValue(OWNER_SESSION);
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(OWNER_SESSION);
  });

  async function seedMedia(status: "ok" | "error", reason?: string): Promise<string> {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `status-ch-${nextRef()}`, name: "Status Channel", active: true },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Flagged Media",
        blob: { kind: "url", url: "https://example.com/v.mp4" },
        mediaType: "video",
        status,
        ...(reason ? { statusReason: reason, statusChangedAt: new Date() } : {}),
      },
    });
    return media.id;
  }

  it("returns 401 when not authenticated (the owner gate runs before any DB work)", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(postReq("any-id", { status: "ok" }), makeContext("any-id"));
    expect(res.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns 403 when an admin who is not the owner attempts a reset", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-2", email: "mgr@test.com", name: "Manager", type: "admin", role: "admin" },
    });
    const res = await POST(postReq("any-id", { status: "ok" }), makeContext("any-id"));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects any body that is not { status: "ok" } with 400', async () => {
    const res = await POST(postReq("any-id", { status: "error" }), makeContext("any-id"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('status: "ok"');
  });

  it("returns 400 on a malformed JSON body", async () => {
    const res = await POST(postReq("any-id", "{not json"), makeContext("any-id"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("returns 404 when the media does not exist", async () => {
    const res = await POST(
      postReq("ckmissingfakefakefakefake", { status: "ok" }),
      makeContext("ckmissingfakefakefakefake")
    );
    expect(res.status).toBe(404);
  });

  it("clears an error flag back to ok (wiping reason, stamping changedAt) and audits the reset", async () => {
    const mediaId = await seedMedia("error", "integrity_auth_failed");

    const res = await POST(postReq(mediaId, { status: "ok" }), makeContext(mediaId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: mediaId, status: "ok" });

    const after = await prisma.media.findUnique({
      where: { id: mediaId },
      select: { status: true, statusReason: true, statusChangedAt: true },
    });
    expect(after?.status).toBe("ok");
    expect(after?.statusReason).toBeNull();
    expect(after?.statusChangedAt).toBeInstanceOf(Date);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        actorType: "admin",
        action: "media.status_reset",
        targetType: "media",
        targetId: mediaId,
        details: expect.objectContaining({
          from: "error",
          to: "ok",
          clearedReason: "integrity_auth_failed",
        }),
      })
    );
  });

  it("is idempotent on already-ok media: returns ok WITHOUT auditing", async () => {
    const mediaId = await seedMedia("ok");
    const res = await POST(postReq(mediaId, { status: "ok" }), makeContext(mediaId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: mediaId, status: "ok" });
    expect(audit).not.toHaveBeenCalled();
  });
});
