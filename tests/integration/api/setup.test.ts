import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

const { isSetupCompleteMock } = vi.hoisted(() => ({
  isSetupCompleteMock: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/setup", () => ({
  isSetupComplete: isSetupCompleteMock,
}));

vi.mock("@/lib/encryption", () => ({
  encryptSecretKey: vi.fn().mockReturnValue("encrypted_key_payload"),
}));

import { POST } from "@/app/api/setup/route";
import { prisma } from "@/lib/prisma";

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/setup", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    isSetupCompleteMock.mockResolvedValue(false);
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  it("returns 403 when setup is already complete", async () => {
    isSetupCompleteMock.mockResolvedValue(true);
    const res = await POST(
      buildRequest({
        instance_name: "Anything",
        satsrail_api_key: "sk_live_x",
        merchant_id: "m_1",
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/already completed/i);
  });

  it("returns 400 when validation fails (missing required fields)", async () => {
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("creates settings with all optional fields populated", async () => {
    const res = await POST(
      buildRequest({
        instance_name: "  My Stream  ",
        logo_url: "https://example.com/logo.png",
        nsfw_enabled: true,
        theme_primary: "#ff00aa",
        satsrail_api_key: "  sk_live_abc  ",
        merchant_id: "  m_42  ",
        merchant_name: "  Acme  ",
        merchant_currency: "EUR",
        merchant_locale: "es",
      })
    );
    expect(res.status).toBe(201);

    const saved = await prisma.settings.findFirst();
    expect(saved).not.toBeNull();
    expect(saved!.instanceName).toBe("My Stream");
    expect(saved!.logoUrl).toBe("https://example.com/logo.png");
    expect(saved!.nsfwEnabled).toBe(true);
    expect(saved!.themePrimary).toBe("#ff00aa");
    expect(saved!.merchantId).toBe("m_42");
    expect(saved!.merchantName).toBe("Acme");
    expect(saved!.merchantCurrency).toBe("EUR");
    expect(saved!.merchantLocale).toBe("es");
    expect(saved!.satsrailApiKeyEncrypted).toBe("encrypted_key_payload");
  });

  it("applies defaults when optional fields are omitted", async () => {
    const res = await POST(
      buildRequest({
        instance_name: "Bare",
        satsrail_api_key: "sk_live_min",
        merchant_id: "m_min",
      })
    );
    expect(res.status).toBe(201);

    const saved = await prisma.settings.findFirst();
    expect(saved!.logoUrl).toBe("");
    expect(saved!.nsfwEnabled).toBe(false);
    expect(saved!.themePrimary).toBe("#3b82f6");
    expect(saved!.merchantName).toBe("");
    expect(saved!.merchantCurrency).toBe("USD");
    expect(saved!.merchantLocale).toBe("en");
  });

  it("treats nsfw_enabled as false when not strictly true", async () => {
    const res = await POST(
      buildRequest({
        instance_name: "No NSFW",
        satsrail_api_key: "sk_live_x",
        merchant_id: "m_x",
        nsfw_enabled: false,
      })
    );
    expect(res.status).toBe(201);
    const saved = await prisma.settings.findFirst();
    expect(saved!.nsfwEnabled).toBe(false);
  });

  it("returns 500 when prisma.settings.create throws", async () => {
    const spy = vi
      .spyOn(prisma.settings, "create")
      .mockRejectedValueOnce(new Error("db offline") as never);

    const res = await POST(
      buildRequest({
        instance_name: "Boom",
        satsrail_api_key: "sk_live_x",
        merchant_id: "m_x",
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Setup failed/i);
    spy.mockRestore();
  });
});
