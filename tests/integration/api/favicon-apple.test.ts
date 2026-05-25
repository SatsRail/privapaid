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
// Sharp stays mocked (slow native binding). The route reads logo data
// straight from Prisma now — no helper to mock.
const { sharpToBuffer, sharpInstance } = vi.hoisted(() => {
  const toBuffer = vi.fn();
  const instance = {
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer,
  };
  return { sharpToBuffer: toBuffer, sharpInstance: instance };
});
vi.mock("sharp", () => ({
  default: vi.fn(() => sharpInstance),
}));

import { GET } from "@/app/api/favicon/apple/route";

function buildReq(url = "http://localhost:3000/api/favicon/apple"): Request {
  return new Request(url);
}

const originalFetch = global.fetch;

describe("GET /api/favicon/apple", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    sharpToBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await clearCollections();
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("redirects to /favicon.ico when there are no settings", async () => {
    const res = await GET(buildReq());
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });

  it("redirects when settings exist but have no logo configured", async () => {
    await createSettings({ instanceName: "x" });
    // createSettings leaves logoBytes null and logoUrl as the schema's
    // empty-string default — the route should redirect.
    const res = await GET(buildReq());
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });

  it("redirects when remote logoUrl fetch returns non-ok", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoUrl: "https://example.com/logo.png" },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch;

    const res = await GET(buildReq());
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });

  it("returns a PNG response when logoBytes are present and sharp succeeds", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("fake-png"), logoMimeType: "image/png" },
    });

    const res = await GET(buildReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
  });

  it("returns a PNG response when logoUrl is set and remote fetch succeeds", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoUrl: "https://example.com/logo.png" },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    }) as unknown as typeof fetch;

    const res = await GET(buildReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("falls back to redirect when sharp throws", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({
      where: { id: 1 },
      data: { logoBytes: Buffer.from("bad-bytes") },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sharpToBuffer.mockRejectedValueOnce(new Error("sharp boom"));

    const res = await GET(buildReq());
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/favicon.ico");
    errSpy.mockRestore();
  });
});
