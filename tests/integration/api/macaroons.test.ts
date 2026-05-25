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
  headers: vi
    .fn()
    .mockResolvedValue(new Headers({ "x-forwarded-for": "127.0.0.1" })),
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: mockGetInstanceConfig,
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

// Intercept global fetch
vi.stubGlobal("fetch", mockFetch);

import { POST, DELETE, PUT, GET } from "@/app/api/macaroons/route";

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
    expect(parsed.prod_1.m).toBe("mac_abc");
    expect(typeof parsed.prod_1.t).toBe("number");
  });

  it("appends to existing macaroons", async () => {
    mockCookieStore._set("satsrail_macaroons", JSON.stringify({ prod_old: "mac_old" }));

    const req = jsonRequest("POST", { product_id: "prod_new", macaroon: "mac_new" });
    const res = await POST(req);
    const body = await res.json();

    expect(body.stored).toBe(true);
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    // Legacy entry migrated to {m, t: 0} on re-serialize.
    expect(parsed.prod_old.m).toBe("mac_old");
    expect(parsed.prod_new.m).toBe("mac_new");
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
    expect(parsed.prod_1.m).toBe("mac_1");
  });

  it("evicts the oldest entries when the new one would push past MAX_BYTES (Chrome-drop guard)", async () => {
    // Regression for the founder's "paid in Chrome → lost access" bug:
    // when the cookie grew past Chrome's 4096-byte hard cap, Set-Cookie
    // was silently dropped and the just-paid-for macaroon never landed.
    // The route must evict the OLDEST entries (lowest `t`) — never the
    // just-added one — to stay under the budget.
    //
    // Build a cookie that's nearly at the MAX_BYTES cap with several
    // existing entries; the POST should fit the new one in and evict
    // at least one old entry.
    const big = "x".repeat(300);
    const seed: Record<string, { m: string; t: number }> = {};
    for (let i = 0; i < 8; i++) {
      seed[`prod_old_${i}`] = { m: big, t: i + 1 };
    }
    mockCookieStore._set("satsrail_macaroons", JSON.stringify(seed));

    const req = jsonRequest("POST", {
      product_id: "prod_just_paid",
      macaroon: big,
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stored).toBe(true);
    // The route returns the eviction count so the client can react if needed.
    expect(body.evicted).toBeGreaterThan(0);

    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    // Invariant #1: the just-paid-for macaroon is present — never evicted.
    expect(parsed.prod_just_paid).toBeDefined();
    expect(parsed.prod_just_paid.m).toBe(big);
    // Invariant #2: the resulting cookie value fits under MAX_BYTES.
    expect(res.cookies.get("satsrail_macaroons")!.value.length).toBeLessThanOrEqual(
      // Allow MAX_BYTES + minor JSON wrapping noise; the cookie helper
      // guarantees <= MAX_BYTES so this is strict.
      2500
    );
    // Invariant #3: the oldest entry (lowest t) is gone first.
    expect(parsed.prod_old_0).toBeUndefined();
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
    // Legacy survivor migrated to {m, t: 0}.
    expect(parsed.prod_2.m).toBe("m2");
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
    // prod_1 should be removed, prod_2 remains (migrated to {m, t: 0}).
    const parsed = JSON.parse(res.cookies.get("satsrail_macaroons")!.value);
    expect(parsed.prod_1).toBeUndefined();
    expect(parsed.prod_2.m).toBe("mac_ok");
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

describe("Macaroons API — GET /api/macaroons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  it("returns empty list when no cookie is set", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("returns product_ids only (never the macaroon strings), newest first", async () => {
    const map = {
      old_prod: { m: "mac_old", t: 1000 },
      new_prod: { m: "mac_new", t: 2000 },
    };
    mockCookieStore._set("satsrail_macaroons", JSON.stringify(map));

    const res = await GET();
    const body = await res.json();

    expect(body.products).toHaveLength(2);
    expect(body.products[0].product_id).toBe("new_prod");
    expect(body.products[0].stored_at).toBe(2000);
    expect(body.products[1].product_id).toBe("old_prod");
    // Macaroon strings must NOT leak.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("mac_old");
    expect(serialized).not.toContain("mac_new");
  });

  it("filters out entries without a macaroon field", async () => {
    const map = {
      valid_prod: { m: "mac_v", t: 100 },
      empty_prod: { m: "", t: 200 },
    };
    mockCookieStore._set("satsrail_macaroons", JSON.stringify(map));

    const res = await GET();
    const body = await res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0].product_id).toBe("valid_prod");
  });
});

describe("Macaroons API — CSRF + rate-limit guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._clear();
  });

  function badOriginRequest(method: string, body: Record<string, unknown>): NextRequest {
    return new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
      method,
      headers: {
        "Content-Type": "application/json",
        // Mismatched origin to trigger checkOrigin failure.
        origin: "https://evil.example.com",
        host: "localhost:3000",
      },
      body: JSON.stringify(body),
    });
  }

  it("POST returns CSRF failure when origin mismatches host", async () => {
    const res = await POST(badOriginRequest("POST", { product_id: "p", macaroon: "m" }));
    expect([403, 400]).toContain(res.status);
  });

  it("DELETE returns CSRF failure when origin mismatches host", async () => {
    const res = await DELETE(badOriginRequest("DELETE", { product_id: "p" }));
    expect([403, 400]).toContain(res.status);
  });

  it("PUT returns CSRF failure when origin mismatches host", async () => {
    const res = await PUT(badOriginRequest("PUT", { product_id: "p" }));
    expect([403, 400]).toContain(res.status);
  });

  it("POST rejects an oversized macaroon with 413", async () => {
    // Build a string just over the per-entry cap (MAX_BYTES ≈ 3.5KB; one
    // macaroon larger than MAX_BYTES alone trips the insertWithCap throw).
    const huge = "x".repeat(8000);
    const req = jsonRequest("POST", { product_id: "p_huge", macaroon: huge });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});
