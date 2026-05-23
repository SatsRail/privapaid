import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockCookieStore, mockGetInstanceConfig, mockFetch } = vi.hoisted(() => {
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
    mockGetInstanceConfig: vi.fn().mockResolvedValue({
      satsrail: { apiUrl: "https://satsrail.test/api/v1" },
    }),
    mockFetch: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: mockGetInstanceConfig,
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

// Intercept global fetch
vi.stubGlobal("fetch", mockFetch);

import { POST, DELETE, PUT } from "@/app/api/macaroons/route";

function jsonRequest(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Macaroons API — POST /api/macaroons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  it("stores a macaroon and sets cookie", async () => {
    const req = jsonRequest("POST", { product_id: "prod_1", macaroon: "mac_abc" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stored).toBe(true);

    const setCookie = res.cookies.get("satsrail_macaroons");
    expect(setCookie).toBeDefined();
    const parsed = JSON.parse(setCookie!.value);
    expect(parsed.prod_1).toBe("mac_abc");
  });

  it("appends to existing macaroons", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_old: "mac_old" }));

    const req = jsonRequest("POST", { product_id: "prod_new", macaroon: "mac_new" });
    const res = await POST(req);
    const body = await res.json();

    expect(body.stored).toBe(true);
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    expect(parsed.prod_old).toBe("mac_old");
    expect(parsed.prod_new).toBe("mac_new");
  });

  it("returns 400 when product_id is missing", async () => {
    const req = jsonRequest("POST", { macaroon: "mac_abc" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("product_id");
  });

  it("returns 400 when macaroon is missing", async () => {
    const req = jsonRequest("POST", { product_id: "prod_1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles malformed cookie value gracefully", async () => {
    mockCookieStore._set("satsrail_macaroons", "not-json");

    const req = jsonRequest("POST", { product_id: "prod_1", macaroon: "mac_1" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    expect(parsed.prod_1).toBe("mac_1");
  });
});

describe("Macaroons API — DELETE /api/macaroons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  it("removes a macaroon and keeps cookie with remaining", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "m1", prod_2: "m2" }));

    const req = jsonRequest("DELETE", { product_id: "prod_1" });
    const res = await DELETE(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.removed).toBe(true);
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    expect(parsed.prod_1).toBeUndefined();
    expect(parsed.prod_2).toBe("m2");
  });

  it("deletes cookie when last macaroon is removed", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "m1" }));

    const req = jsonRequest("DELETE", { product_id: "prod_1" });
    const res = await DELETE(req);
    const body = await res.json();

    expect(body.removed).toBe(true);
    // Cookie should be deleted (maxAge=-1 or empty)
    // In NextResponse, deleting sets maxAge to 0
  });

  it("returns 400 when product_id is missing", async () => {
    const req = jsonRequest("DELETE", {});
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });
});

describe("Macaroons API — PUT /api/macaroons (verify)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  it("returns 400 when product_id is missing", async () => {
    const req = jsonRequest("PUT", {});
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no macaroon found for product", async () => {
    // No cookie set at all
    const req = jsonRequest("PUT", { product_id: "prod_missing" });
    const res = await PUT(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No macaroon found");
  });

  it("returns 404 and cleans up empty macaroon entry from cookie", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "", prod_2: "mac_ok" }));

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No macaroon found");
    // prod_1 should be removed, prod_2 remains
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    expect(parsed.prod_1).toBeUndefined();
    expect(parsed.prod_2).toBe("mac_ok");
  });

  it("deletes cookie entirely when cleaning up the only empty entry", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "" }));

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    expect(res.status).toBe(404);
  });

  it("returns verification data when macaroon is valid", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_valid" }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, key: "decryption_key", remaining_seconds: 3600 }),
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toBe("decryption_key");
    expect(body.remaining_seconds).toBe(3600);
  });

  it("returns 410 and PRESERVES the cookie when portal rejects (402)", async () => {
    // Architectural change (worktree dazzling-nightingale): a single 402 used
    // to clear the rejected entry from the cookie. That meant a transient
    // portal hiccup or a signing-key rotation race locked the user out for
    // the rest of the cookie's lifetime, even when they had JUST paid. The
    // new behavior is to leave the cookie alone — the client treats 410 as
    // "no access right now" and a refresh re-attempts verification.
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_bad", prod_2: "mac_ok" }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ valid: false, error: { code: "access_expired" } }),
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toBe("Access expired");
    // Cookie MUST NOT be touched — no Set-Cookie header on this response.
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });

  it("returns 410 even when the rejected macaroon is the only one (still preserves cookie)", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_bad" }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ valid: false, error: { code: "access_expired" } }),
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    expect(res.status).toBe(410);
    // Same invariant: no Set-Cookie. The cookie lives until natural expiry.
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });

  it("returns 502 and KEEPS the macaroon when portal returns 5xx", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_paid", prod_2: "mac_other" }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Verification temporarily unavailable");
    // Critical: cookie must NOT be touched on transient portal failure.
    // res.cookies.get returns undefined when no Set-Cookie header was emitted.
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });

  it("returns 502 and KEEPS the macaroon when portal returns 401 (merchant auth issue)", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_paid" }));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Verification temporarily unavailable");
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });

  it("returns 502 and KEEPS the macaroon when fetch throws (network error)", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_paid" }));

    mockFetch.mockRejectedValue(new Error("network error"));

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Verification temporarily unavailable");
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });

  it("returns 502 and KEEPS the macaroon when portal body is unexpectedly shaped", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_1: "mac_paid" }));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ remaining_seconds: 0 }), // missing valid:true
    });

    const req = jsonRequest("PUT", { product_id: "prod_1" });
    const res = await PUT(req);

    expect(res.status).toBe(502);
    expect(res.cookies.get("satsrail_macaroons")).toBeUndefined();
  });
});
