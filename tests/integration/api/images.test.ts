import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

// ── Hoisted mocks ──────────────────────────────────────────────────
// auth and file-type stay mocked — they're not part of what we're testing,
// and the real auth() pulls in the full NextAuth flow.
// sharp stays mocked too — its native binding is slow and we only need to
// verify the route's handling of its results.
const {
  mockAuth,
  mockFileTypeFromBuffer,
  mockSharpMeta,
  mockSharpRotate,
  mockSharpToBuffer,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn().mockResolvedValue(null),
  mockFileTypeFromBuffer: vi.fn().mockResolvedValue({ mime: "image/png" }),
  mockSharpMeta: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
  mockSharpRotate: vi.fn(),
  mockSharpToBuffer: vi.fn().mockResolvedValue(Buffer.from("stripped")),
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

const mockSharpInstance = {
  metadata: mockSharpMeta,
  rotate: mockSharpRotate,
  toBuffer: mockSharpToBuffer,
};
mockSharpRotate.mockReturnValue(mockSharpInstance);

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("file-type", () => ({ fileTypeFromBuffer: mockFileTypeFromBuffer }));
vi.mock("sharp", () => ({
  default: vi.fn().mockReturnValue(mockSharpInstance),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

import { POST } from "@/app/api/images/route";

function buildFormRequest(fields: Record<string, string | File>): NextRequest {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest(new URL("http://localhost:3000/api/images"), {
    method: "POST",
    body: formData,
  });
}

function makePngFile(size = 100): File {
  const buffer = new Uint8Array(size);
  return new File([buffer], "test.png", { type: "image/png" });
}

describe("Images API — POST /api/images", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockAuth.mockResolvedValue({ user: { id: "admin-1", type: "admin" } });
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png" });
    mockSharpMeta.mockResolvedValue({ width: 100, height: 100 });
    mockSharpRotate.mockReturnValue(mockSharpInstance);
    mockSharpToBuffer.mockResolvedValue(Buffer.from("stripped"));
    mockRateLimit.mockResolvedValue(null);
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValueOnce(null);

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when session has no user", async () => {
    mockAuth.mockResolvedValueOnce({});

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file provided", async () => {
    const formData = new FormData();
    const req = new NextRequest(new URL("http://localhost:3000/api/images"), {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("No file provided");
  });

  it("returns 422 for disallowed MIME type", async () => {
    const file = new File([new Uint8Array(100)], "test.pdf", { type: "application/pdf" });
    const req = buildFormRequest({ file });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("Invalid file type");
  });

  it("returns 422 when file is too large", async () => {
    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" });
    const req = buildFormRequest({ file: bigFile });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("too large");
  });


  it("returns 422 when file magic bytes do not match allowed type", async () => {
    mockFileTypeFromBuffer.mockResolvedValueOnce({ mime: "application/octet-stream" });

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("does not match");
  });

  it("returns 422 when file-type detection returns null", async () => {
    mockFileTypeFromBuffer.mockResolvedValueOnce(null);

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("does not match");
  });

  it("returns 422 when image dimensions exceed 8192", async () => {
    mockSharpMeta.mockResolvedValueOnce({ width: 9000, height: 100 });

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("9000x100");
    expect(body.error).toContain("max 8192x8192");
  });

  it("returns 422 when sharp cannot read dimensions", async () => {
    mockSharpMeta.mockRejectedValueOnce(new Error("corrupt image"));

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    // The error includes the underlying sharp message so server logs and the
    // client can both see what actually failed.
    expect(body.error).toBe(
      "Unable to read image dimensions: corrupt image"
    );
  });

  it("uploads image and returns image_id on success", async () => {
    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(typeof body.image_id).toBe("string");

    // Confirm the row exists in Postgres
    const blob = await prisma.previewImage.findUnique({
      where: { id: body.image_id },
      select: { id: true },
    });
    expect(blob).not.toBeNull();
  });

  it("defaults context to general when not specified", async () => {
    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    // Even without context, the row lands in PreviewImage (the shim
    // path described in the route comment).
    const blob = await prisma.previewImage.findUnique({
      where: { id: body.image_id },
    });
    expect(blob).not.toBeNull();
  });

  it("returns rate limit response when rate limited", async () => {
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const req = buildFormRequest({ file: makePngFile() });
    const res = await POST(req);

    expect(res.status).toBe(429);
  });
});
