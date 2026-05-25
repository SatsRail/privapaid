import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
  requireCustomerApi: vi.fn().mockResolvedValue({ id: "customer-1", name: "testuser" }),
}));
vi.mock("@/lib/satsrail", () => ({ satsrail: {} }));
vi.mock("@/lib/merchant-key", () => ({ getMerchantKey: vi.fn().mockResolvedValue("sk_test_key") }));

vi.mock("@/config/instance", () => ({
  default: {
    satsrail: { apiUrl: "https://api.satsrail.com" },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// We need to reset the module cache between tests to clear the in-memory cache
// in the exchanges route. We'll use dynamic imports after resetModules.

let GET: (req: NextRequest) => Promise<Response>;

describe("Exchanges API", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    // Reset modules to clear the cached exchanges between tests
    vi.resetModules();

    // Re-apply mocks that get lost on resetModules
    vi.doMock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
    vi.doMock("next/headers", () => ({
      headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
    }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
    vi.doMock("@/lib/auth-helpers", () => ({
      requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
      requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "admin@test.com", role: "owner" }),
      requireCustomerApi: vi.fn().mockResolvedValue({ id: "customer-1", name: "testuser" }),
    }));
    vi.doMock("@/lib/satsrail", () => ({ satsrail: {} }));
    vi.doMock("@/lib/merchant-key", () => ({ getMerchantKey: vi.fn().mockResolvedValue("sk_test_key") }));
    vi.doMock("@/config/instance", () => ({
      default: {
        satsrail: { apiUrl: "https://api.satsrail.com" },
      },
    }));

    const mod = await import("@/app/api/exchanges/route");
    GET = mod.GET;
  });

  afterEach(async () => {
    await clearCollections();
    mockFetch.mockReset();
  });

  it("returns all exchanges when no country header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        exchanges: [
          { name: "Exchange A", countries: [{ iso_code: "US" }] },
          { name: "Exchange B", countries: [{ iso_code: "BR" }] },
        ],
      }),
    });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges"));
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(2);
    expect(body.country_code).toBeNull();
  });

  it("filters exchanges by country code from x-vercel-ip-country header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        exchanges: [
          { name: "Exchange A", countries: [{ iso_code: "US" }] },
          { name: "Exchange B", countries: [{ iso_code: "BR" }] },
          { name: "Exchange C", countries: [{ iso_code: "US" }, { iso_code: "CA" }] },
        ],
      }),
    });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges"), {
      headers: { "x-vercel-ip-country": "US" },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(2);
    expect(body.exchanges.map((e: { name: string }) => e.name)).toEqual(["Exchange A", "Exchange C"]);
    expect(body.country_code).toBe("US");
  });

  it("returns all exchanges when ?all=1 even with country header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        exchanges: [
          { name: "Exchange A", countries: [{ iso_code: "US" }] },
          { name: "Exchange B", countries: [{ iso_code: "BR" }] },
        ],
      }),
    });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges?all=1"), {
      headers: { "x-vercel-ip-country": "US" },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(2);
    expect(body.country_code).toBe("US");
  });

  it("returns empty exchanges when upstream fetch fails", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges"));
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(0);
  });

  it("uses cf-ipcountry header as fallback", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        exchanges: [
          { name: "Exchange A", countries: [{ iso_code: "GB" }] },
          { name: "Exchange B", countries: [{ iso_code: "FR" }] },
        ],
      }),
    });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges"), {
      headers: { "cf-ipcountry": "GB" },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(1);
    expect(body.exchanges[0].name).toBe("Exchange A");
    expect(body.country_code).toBe("GB");
  });

  it("handles missing exchanges key in response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const req = new NextRequest(new URL("http://localhost:3000/api/exchanges"));
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.exchanges).toHaveLength(0);
  });
});
