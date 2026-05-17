import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockBucketFind, mockBucketOpenDownloadStream, mockRateLimit } = vi.hoisted(() => ({
  mockBucketFind: vi.fn(),
  mockBucketOpenDownloadStream: vi.fn(),
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/gridfs", () => ({
  getEncryptedPhotosBucket: vi.fn().mockResolvedValue({
    find: mockBucketFind,
    openDownloadStream: mockBucketOpenDownloadStream,
  }),
}));

import { GET } from "@/app/api/photos/[id]/route";

function buildRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(new URL(`http://localhost:3000/api/photos/${id}`), {
    method: "GET",
  });
  return [req, { params: Promise.resolve({ id }) }];
}

function asyncIter(chunks: Buffer[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("GET /api/photos/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue(null);
  });

  it("returns 400 for invalid ObjectId", async () => {
    const [req, ctx] = buildRequest("not-an-objectid");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Invalid photo ID/i);
  });

  it("returns 404 when the encrypted photo is missing in GridFS", async () => {
    mockBucketFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe("Photo not found");
  });

  it("streams ciphertext with application/octet-stream — not an image MIME", async () => {
    // Critical: the response Content-Type must NOT reveal the underlying image
    // type. The body is AES-GCM ciphertext, not an image — labelling it
    // `image/jpeg` would tempt browsers to try and render it (and could give
    // false confidence about what's being served).
    const ciphertext = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    mockBucketFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ _id: "507f1f77bcf86cd799439011" }]),
    });
    mockBucketOpenDownloadStream.mockReturnValue(asyncIter([ciphertext]));

    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Length")).toBe(String(ciphertext.length));
    expect(res.headers.get("ETag")).toBe('"507f1f77bcf86cd799439011"');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(ciphertext)).toBe(true);
  });

  it("concatenates multiple chunks into a single response body", async () => {
    const c1 = Buffer.from([0x01, 0x02]);
    const c2 = Buffer.from([0x03, 0x04, 0x05]);
    mockBucketFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ _id: "507f1f77bcf86cd799439011" }]),
    });
    mockBucketOpenDownloadStream.mockReturnValue(asyncIter([c1, c2]));

    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(Buffer.concat([c1, c2]))).toBe(true);
  });

  it("honors the rate limiter", async () => {
    const { NextResponse } = await import("next/server");
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
    );
    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);
    expect(res.status).toBe(429);
    // Bucket lookup never happens when rate-limited
    expect(mockBucketFind).not.toHaveBeenCalled();
  });

  it("does not gate on auth — encrypted bytes are safe to serve publicly", async () => {
    // Test the contract by simply NOT mocking auth: if the route required auth
    // it would 401 here. Confirm it returns the bytes.
    const ciphertext = Buffer.from([0xaa, 0xbb]);
    mockBucketFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ _id: "507f1f77bcf86cd799439011" }]),
    });
    mockBucketOpenDownloadStream.mockReturnValue(asyncIter([ciphertext]));

    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
  });

  it("returns 500 with a structured error when GridFS throws", async () => {
    mockBucketFind.mockReturnValue({
      toArray: vi.fn().mockRejectedValue(new Error("gridfs broken")),
    });

    const [req, ctx] = buildRequest("507f1f77bcf86cd799439011");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/Failed to serve photo/i);
  });
});
