import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
import { encryptSourceUrl } from "@/lib/content-encryption";

// ── Hoisted mocks ──────────────────────────────────────────────────
// Mirror the unlock route's test surface: a cookie store the gate reads
// the macaroon from, and a fetch stub for the single SatsRail verify call.
const { mockCookieStore, mockFetch } = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    mockCookieStore: {
      get: vi.fn((name: string) => {
        if (store[name]) return { value: store[name] };
        return undefined;
      }),
      _set: (name: string, value: string) => { store[name] = value; },
      _clear: () => { for (const k in store) delete store[k]; },
    },
    mockFetch: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({
    satsrail: { apiUrl: "https://satsrail.test/api/v1" },
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

// The confirm path is rate-limited; make the limiter a no-op so tests
// exercise the real flow.
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Audit is a side-channel; mock it so we can assert the flag event without
// depending on AuditLog headers()/IP plumbing.
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.stubGlobal("fetch", mockFetch);

import { POST } from "@/app/api/media/[id]/report-error/route";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

let refSeed = 9000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/media/${id}/report-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Portal `/m/access/verify` says the macaroon is valid and hands back `key`. */
function mockPortalValid(key: string) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ valid: true, key, remaining_seconds: 3600 }),
  });
}

describe("Media report-error API — POST /api/media/[id]/report-error", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  /**
   * Seed an active channel + url-backed media + one media-scoped product whose
   * encryptedSource is supplied by the caller. The product key (`keyB64url`)
   * matches what the portal-verify mock returns so the server's confirm decrypt
   * runs against a known key.
   */
  async function seed(opts: {
    encryptedSource: string;
    productId?: string;
    mediaStatus?: "ok" | "error";
  }) {
    const productId = opts.productId ?? "prod_report";
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `report-ch-${nextRef()}`,
        name: "Report Channel",
        active: true,
      },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Reportable Video",
        blob: { kind: "url", url: "https://example.com/video.mp4" },
        mediaType: "video",
        ...(opts.mediaStatus ? { status: opts.mediaStatus } : {}),
      },
    });
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: productId,
      encryptedSource: opts.encryptedSource,
      keyFingerprint: "fp_report",
    });
    return { channelId: channel.id, mediaId: media.id, productId };
  }

  it("rejects an unknown reason with 400 (no free-text ever persisted)", async () => {
    const res = await POST(postReq("any-id", { reason: "free text exploit" }), makeContext("any-id"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Unknown reason");
    // Rejected before any portal call.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed JSON body", async () => {
    const req = new Request("http://localhost:3000/api/media/x/report-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, makeContext("x"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 404 when the media does not exist", async () => {
    const res = await POST(
      postReq("ckmissingfakefakefakefake", { reason: "integrity_auth_failed" }),
      makeContext("ckmissingfakefakefakefake")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 404 when the channel is inactive", async () => {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `inactive-${nextRef()}`, name: "Inactive", active: false },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Inactive Media",
        blob: { kind: "url", url: "https://example.com/x.mp4" },
        mediaType: "video",
      },
    });

    const res = await POST(
      postReq(media.id, { reason: "integrity_auth_failed" }),
      makeContext(media.id)
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Channel not found");
  });

  it("returns 401 when the reporter holds no valid macaroon (only paying viewers may report)", async () => {
    const { mediaId } = await seed({ encryptedSource: "Zm9vYmFy" });
    // No cookie set → verifyMacaroonAccess → granted:false.

    const res = await POST(
      postReq(mediaId, { reason: "integrity_auth_failed" }),
      makeContext(mediaId)
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Payment required");
    // No portal call needed — the cookie had nothing to verify.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT flag the media when the server can still decrypt (confirmed:false)", async () => {
    // The client reported a failure, but the blob decrypts cleanly server-side
    // with the portal-returned key. A single false client report must never
    // take good content offline.
    const keyB64url = randomBytes(32).toString("base64url");
    const productId = "prod_good";
    const goodBlob = encryptSourceUrl("https://example.com/video.mp4", keyB64url, productId);

    const { mediaId } = await seed({ encryptedSource: goodBlob, productId });
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ [productId]: "mac" }));
    mockPortalValid(keyB64url);

    const res = await POST(
      postReq(mediaId, { reason: "integrity_auth_failed" }),
      makeContext(mediaId)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ confirmed: false });

    // Status untouched, no audit event.
    const after = await prisma.media.findUnique({
      where: { id: mediaId },
      select: { status: true, statusReason: true, statusChangedAt: true },
    });
    expect(after?.status).toBe("ok");
    expect(after?.statusReason).toBeNull();
    expect(after?.statusChangedAt).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("flags the media when the server ALSO fails to decrypt (confirmed:true + audit)", async () => {
    // A corrupt/too-short blob: the server's decrypt throws "Blob too short",
    // confirming the integrity failure. Now we flag and audit.
    const keyB64url = randomBytes(32).toString("base64url");
    const productId = "prod_bad";
    const { mediaId } = await seed({ encryptedSource: "Zm9vYmFy", productId });
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ [productId]: "mac" }));
    mockPortalValid(keyB64url);

    const res = await POST(
      postReq(mediaId, { reason: "integrity_auth_failed", orderId: "ord_123" }),
      makeContext(mediaId)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ confirmed: true });

    const after = await prisma.media.findUnique({
      where: { id: mediaId },
      select: { status: true, statusReason: true, statusChangedAt: true },
    });
    expect(after?.status).toBe("error");
    expect(after?.statusReason).toBe("integrity_auth_failed");
    expect(after?.statusChangedAt).toBeInstanceOf(Date);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "system",
        action: "media.decrypt_error",
        targetType: "media",
        targetId: mediaId,
        details: expect.objectContaining({
          reason: "integrity_auth_failed",
          productId,
          orderId: "ord_123",
        }),
      })
    );
  });

  it("is idempotent on already-flagged media: acknowledges WITHOUT hitting the portal", async () => {
    const productId = "prod_flagged";
    const { mediaId } = await seed({
      encryptedSource: "Zm9vYmFy",
      productId,
      mediaStatus: "error",
    });
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ [productId]: "mac" }));

    const res = await POST(
      postReq(mediaId, { reason: "integrity_auth_failed" }),
      makeContext(mediaId)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ confirmed: true, alreadyFlagged: true });
    // Short-circuit happens before the portal verify — this is the
    // portal-protection guarantee.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
