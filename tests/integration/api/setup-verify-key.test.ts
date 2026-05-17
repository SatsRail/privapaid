import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";

const { isSetupCompleteMock } = vi.hoisted(() => ({
  isSetupCompleteMock: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/setup", () => ({
  isSetupComplete: isSetupCompleteMock,
}));

vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));

import { POST } from "@/app/api/setup/verify-key/route";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/setup/verify-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/setup/verify-key", () => {
  beforeEach(() => {
    isSetupCompleteMock.mockResolvedValue(false);
    mockSatsrailClient.getMerchant.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when setup is already complete", async () => {
    isSetupCompleteMock.mockResolvedValue(true);
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_x" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/already completed/i);
  });

  it("returns 400 when satsrail_api_key is missing", async () => {
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
  });

  it("returns merchant details on success with all fields populated", async () => {
    mockSatsrailClient.getMerchant.mockResolvedValue({
      id: "m_1",
      name: "Acme",
      currency: "EUR",
      locale: "es",
      logo_url: "https://example.com/logo.png",
    });
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_good" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      merchant_id: "m_1",
      merchant_name: "Acme",
      merchant_currency: "EUR",
      merchant_locale: "es",
      merchant_logo_url: "https://example.com/logo.png",
    });
  });

  it("applies fallback defaults when merchant has missing optional fields", async () => {
    mockSatsrailClient.getMerchant.mockResolvedValue({
      id: "m_2",
      name: "Bare",
    });
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_bare" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      merchant_id: "m_2",
      merchant_name: "Bare",
      merchant_currency: "USD",
      merchant_locale: "en",
      merchant_logo_url: "",
    });
  });

  it("maps 401 errors to 'Invalid API key'", async () => {
    mockSatsrailClient.getMerchant.mockRejectedValue(
      new Error("SatsRail API error 401: unauthorized")
    );
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid API key");
  });

  it("maps 403 errors to a 'not yet active' message", async () => {
    mockSatsrailClient.getMerchant.mockRejectedValue(
      new Error("SatsRail API error 403: forbidden")
    );
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_pending" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not yet active/i);
  });

  it("returns generic message for other Error instances", async () => {
    mockSatsrailClient.getMerchant.mockRejectedValue(
      new Error("ECONNREFUSED")
    );
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_offline" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Failed to verify/i);
  });

  it("returns generic message for non-Error throws", async () => {
    mockSatsrailClient.getMerchant.mockRejectedValue("plain string");
    const res = await POST(buildRequest({ satsrail_api_key: "sk_live_string_err" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Failed to verify/i);
  });
});
