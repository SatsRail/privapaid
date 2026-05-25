import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockGetLogoBuffer, mockSharpResize, mockSharpPng, mockSharpToBuffer, mockSharpInstance } = vi.hoisted(() => {
  const _mockSharpResize = vi.fn();
  const _mockSharpPng = vi.fn();
  const _mockSharpToBuffer = vi.fn();
  const _mockSharpInstance = {
    resize: _mockSharpResize,
    png: _mockSharpPng,
    toBuffer: _mockSharpToBuffer,
  };
  _mockSharpResize.mockReturnValue(_mockSharpInstance);
  _mockSharpPng.mockReturnValue(_mockSharpInstance);
  return {
    mockGetLogoBuffer: vi.fn(),
    mockSharpResize: _mockSharpResize,
    mockSharpPng: _mockSharpPng,
    mockSharpToBuffer: _mockSharpToBuffer,
    mockSharpInstance: _mockSharpInstance,
  };
});

vi.mock("@/lib/logo", () => ({
  getLogoBuffer: mockGetLogoBuffer,
}));

vi.mock("sharp", () => ({
  default: vi.fn().mockReturnValue(mockSharpInstance),
}));

import { GET } from "@/app/api/favicon/route";

function buildRequest(): Request {
  return new Request("http://localhost:3000/api/favicon", { method: "GET" });
}

describe("GET /api/favicon", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSharpResize.mockReturnValue(mockSharpInstance);
    mockSharpPng.mockReturnValue(mockSharpInstance);
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns PNG favicon when settings have logoBytes", async () => {
    const faviconBuffer = Buffer.from("fake-png-data");
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("raw-logo"), logoMimeType: "image/png" },
    });
    mockGetLogoBuffer.mockResolvedValue(Buffer.from("raw-logo"));
    mockSharpToBuffer.mockResolvedValue(faviconBuffer);

    const res = await GET(buildRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("public");
  });

  it("returns PNG favicon when settings have logoUrl", async () => {
    const faviconBuffer = Buffer.from("fake-png-data");
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoUrl: "https://example.com/logo.png" },
    });
    mockGetLogoBuffer.mockResolvedValue(Buffer.from("raw-logo"));
    mockSharpToBuffer.mockResolvedValue(faviconBuffer);

    const res = await GET(buildRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("redirects to /favicon.ico when no logo settings exist", async () => {
    await createSettings();

    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });

  it("redirects to /favicon.ico when settings is null", async () => {
    // No settings row
    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });

  it("redirects to /favicon.ico when getLogoBuffer returns null", async () => {
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("raw-logo") },
    });
    mockGetLogoBuffer.mockResolvedValue(null);

    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });

  it("redirects to /favicon.ico when sharp throws", async () => {
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("raw-logo") },
    });
    mockGetLogoBuffer.mockResolvedValue(Buffer.from("raw-logo"));
    mockSharpToBuffer.mockRejectedValue(new Error("Sharp processing failed"));

    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });
});
