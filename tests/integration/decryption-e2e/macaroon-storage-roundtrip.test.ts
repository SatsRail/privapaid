import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Macaroon storage round-trip specs.
 *
 * PaymentWall.handleCheckoutComplete POSTs to /api/macaroons after a
 * successful payment to persist the macaroon in an httpOnly cookie.
 * The next page load (or HeartbeatManager tick) then PUTs to the same
 * endpoint to verify the stored macaroon against the SatsRail portal.
 *
 * If POST silently stores nothing, or if PUT can't retrieve what POST
 * stored, the customer pays, comes back, and sees the pay buttons again
 * with no error indication — exactly the "still shows pay screen after
 * payment" failure mode the screenshot suggested.
 *
 * These specs pin the storage contract: what POST writes is exactly
 * what PUT can read, across the JSON shape, cookie parsing, and the
 * portal verify proxy.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockCookieStore, mockFetch } = vi.hoisted(() => {
  const cookies: Record<string, string> = {};
  const setCookies: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
  return {
    mockCookieStore: {
      get: vi.fn((name: string) => (cookies[name] ? { value: cookies[name] } : undefined)),
      set: vi.fn((name: string, value: string, opts: Record<string, unknown>) => {
        cookies[name] = value;
        setCookies.push({ name, value, opts });
      }),
      delete: vi.fn((name: string) => {
        delete cookies[name];
      }),
      _cookies: cookies,
      _setCalls: setCookies,
      _reset: () => {
        for (const k in cookies) delete cookies[k];
        setCookies.length = 0;
      },
    },
    mockFetch: vi.fn(),
  };
});

// NextResponse's cookies API uses a Set-Cookie header internally; the
// route handlers call `response.cookies.set(...)`. We capture that by
// tapping the underlying request cookies in `next/headers` and the
// response cookies via a manual proxy.

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({
    satsrail: { apiUrl: "https://satsrail.test/api/v1" },
  }),
}));

vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test"),
}));

vi.stubGlobal("fetch", mockFetch);

import { POST, PUT, DELETE } from "@/app/api/macaroons/route";

// ── Helpers ───────────────────────────────────────────────────────────

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getSetCookieValue(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const match = c.match(new RegExp(`^${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  // Fallback: single Set-Cookie header
  const single = res.headers.get("set-cookie");
  if (single) {
    const match = single.match(new RegExp(`${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Propagate the Set-Cookie from `res` into the mock cookie store the
 * next request will read from — simulates browser cookie persistence
 * between sequential POST and PUT/DELETE calls.
 */
function persistCookies(res: Response) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = decodeURIComponent(pair.slice(eq + 1));
    if (value === "") {
      delete mockCookieStore._cookies[name];
    } else {
      mockCookieStore._cookies[name] = value;
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("/api/macaroons storage round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieStore._reset();
  });

  it("POST stores a macaroon for a product (Set-Cookie carries the JSON map)", async () => {
    const res = await POST(
      jsonRequest("http://localhost:3000/api/macaroons", {
        product_id: "prod-1",
        macaroon: "mac-abc-123",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toBe(true);

    // The Set-Cookie value must be a valid JSON map containing our entry.
    const cookieValue = getSetCookieValue(res, "satsrail_macaroons");
    expect(cookieValue).toBeTruthy();
    const parsed = JSON.parse(cookieValue!);
    expect(parsed["prod-1"]).toBe("mac-abc-123");
  });

  it("POST then PUT: portal verify proxy returns the verify response when macaroon is stored", async () => {
    // Step 1: store the macaroon. The cookie store mock retains it.
    const postRes = await POST(
      jsonRequest("http://localhost:3000/api/macaroons", {
        product_id: "prod-1",
        macaroon: "mac-real",
      })
    );
    persistCookies(postRes);
    expect(mockCookieStore._cookies["satsrail_macaroons"]).toBeTruthy();

    // Step 2: PUT proxies to SatsRail. Mock the portal verify call.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: "portal-returned-key",
        key_fingerprint: "fp-xyz",
        remaining_seconds: 3600,
      }),
    });

    const putReq = new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "prod-1" }),
    });
    const putRes = await PUT(putReq);

    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.key).toBe("portal-returned-key");
    expect(putBody.remaining_seconds).toBe(3600);

    // Portal was called with the stored macaroon, NOT a different value.
    const portalCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/m/access/verify")
    );
    expect(portalCall).toBeTruthy();
    const portalReqBody = JSON.parse((portalCall![1] as RequestInit).body as string);
    expect(portalReqBody.access_token).toBe("mac-real");
  });

  it("PUT returns 404 when no macaroon is stored for the product", async () => {
    const putReq = new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "never-stored" }),
    });
    const res = await PUT(putReq);
    expect(res.status).toBe(404);
  });

  it("POST is additive — adding a second product preserves the first", async () => {
    persistCookies(await POST(jsonRequest("http://localhost:3000/api/macaroons", { product_id: "p1", macaroon: "m1" })));
    persistCookies(await POST(jsonRequest("http://localhost:3000/api/macaroons", { product_id: "p2", macaroon: "m2" })));

    const cookie = JSON.parse(mockCookieStore._cookies["satsrail_macaroons"]);
    expect(cookie).toEqual({ p1: "m1", p2: "m2" });
  });

  it("POST rejects missing fields with 400", async () => {
    const r1 = await POST(jsonRequest("http://localhost:3000/api/macaroons", { macaroon: "m" }));
    expect(r1.status).toBe(400);
    const r2 = await POST(jsonRequest("http://localhost:3000/api/macaroons", { product_id: "p" }));
    expect(r2.status).toBe(400);
  });

  it("DELETE removes one product's macaroon and leaves the rest", async () => {
    persistCookies(await POST(jsonRequest("http://localhost:3000/api/macaroons", { product_id: "p1", macaroon: "m1" })));
    persistCookies(await POST(jsonRequest("http://localhost:3000/api/macaroons", { product_id: "p2", macaroon: "m2" })));

    const delReq = new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "p1" }),
    });
    const res = await DELETE(delReq);
    persistCookies(res);
    expect(res.status).toBe(200);

    const cookie = JSON.parse(mockCookieStore._cookies["satsrail_macaroons"]);
    expect(cookie).toEqual({ p2: "m2" });
  });

  it("end-to-end: store → verify → matches what PaymentWall expects", async () => {
    // The contract PaymentWall depends on:
    //   POST { product_id, macaroon } → Set-Cookie
    //   PUT { product_id } → { key, key_fingerprint, remaining_seconds }
    // If this contract breaks, post-payment unlock + page reload both fail.
    const PRODUCT_ID = "prod-real-1";
    const MACAROON = "macaroon-real-xyz";
    const KEY = "key-from-portal-base64url";
    const FP = "fingerprint-hex";

    persistCookies(await POST(
      jsonRequest("http://localhost:3000/api/macaroons", {
        product_id: PRODUCT_ID,
        macaroon: MACAROON,
      })
    ));

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        key: KEY,
        key_fingerprint: FP,
        remaining_seconds: 86400,
      }),
    });

    const putReq = new NextRequest(new URL("http://localhost:3000/api/macaroons"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: PRODUCT_ID }),
    });
    const putRes = await PUT(putReq);
    const putBody = await putRes.json();

    // Exact shape PaymentWall's checkAccess loop expects:
    //   data.key
    //   data.key_fingerprint (or product.keyFingerprint fallback)
    //   data.remaining_seconds
    expect(putBody.key).toBe(KEY);
    expect(putBody.key_fingerprint).toBe(FP);
    expect(putBody.remaining_seconds).toBe(86400);
  });
});
