import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createSettings } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

const { getLogoBufferMock } = vi.hoisted(() => ({
  getLogoBufferMock: vi.fn(),
}));
vi.mock("@/lib/logo", () => ({ getLogoBuffer: getLogoBufferMock }));

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
    // Settings is created without logoBytes/logoUrl by default → factory leaves them empty
    await prisma.settings.update({ where: { id: 1 }, data: { logoUrl: "" } });
    const res = await GET(buildReq());
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });

  it("redirects when getLogoBuffer returns null", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({ where: { id: 1 }, data: { logoUrl: "https://example.com/logo.png" } });
    getLogoBufferMock.mockResolvedValue(null);

    const res = await GET(buildReq());
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });

  it("returns a PNG response when the logo can be processed", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({ where: { id: 1 }, data: { logoUrl: "https://example.com/logo.png" } });
    getLogoBufferMock.mockResolvedValue(Buffer.from("fake-png"));

    const res = await GET(buildReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
  });

  it("falls back to redirect when sharp throws", async () => {
    await createSettings({ instanceName: "x" });
    await prisma.settings.update({ where: { id: 1 }, data: { logoUrl: "https://example.com/logo.png" } });
    getLogoBufferMock.mockResolvedValue(Buffer.from("bad-bytes"));
    sharpToBuffer.mockRejectedValueOnce(new Error("sharp boom"));

    const res = await GET(buildReq());
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/favicon.ico");
  });
});
