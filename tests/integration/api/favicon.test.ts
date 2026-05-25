import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// ── Hoisted mocks ──────────────────────────────────────────────────
// Keep sharp mocked — its native binding is slow and we only need to
// verify the route's handling of its results. The route now reads
// logo bytes/url directly from Settings via Prisma; no `getLogoBuffer`
// shim is involved.
const { mockSharpResize, mockSharpPng, mockSharpToBuffer, mockSharpInstance } =
  vi.hoisted(() => {
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
      mockSharpResize: _mockSharpResize,
      mockSharpPng: _mockSharpPng,
      mockSharpToBuffer: _mockSharpToBuffer,
      mockSharpInstance: _mockSharpInstance,
    };
  });

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
    mockSharpToBuffer.mockResolvedValue(faviconBuffer);

    const res = await GET(buildRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("public");
  });

  it("returns PNG favicon when settings have logoUrl (fetched remotely)", async () => {
    const faviconBuffer = Buffer.from("fake-png-data");
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoUrl: "https://example.com/logo.png" },
    });
    // Mock the remote fetch the route makes for logoUrl.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    }) as unknown as typeof fetch;
    mockSharpToBuffer.mockResolvedValue(faviconBuffer);

    const res = await GET(buildRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("redirects to /favicon.ico when settings exist but have no logo configured", async () => {
    // createSettings doesn't set logoBytes; the schema default for logoUrl is
    // an empty string. The route treats falsy logoUrl AND null logoBytes as
    // "no logo".
    await createSettings();

    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });

  it("redirects to /favicon.ico when no completed-setup settings row exists", async () => {
    // No row at all — the route's findFirst({ setupCompleted: true }) returns
    // null and the route redirects.
    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
  });

  it("redirects to /favicon.ico when the remote logoUrl fetch fails", async () => {
    await createSettings();
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoUrl: "https://example.com/logo.png" },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch;

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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSharpToBuffer.mockRejectedValue(new Error("Sharp processing failed"));

    const res = await GET(buildRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("/favicon.ico");
    errSpy.mockRestore();
  });
});
