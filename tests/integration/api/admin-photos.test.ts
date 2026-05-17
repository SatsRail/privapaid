import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks (must come before route import) ─────────────────────
const {
  mockRequireAdminApi,
  mockFileTypeFromBuffer,
  mockSharpMeta,
  mockSharpRotate,
  mockSharpToBuffer,
  mockBucketOpenUploadStream,
  mockUploadOn,
  mockUploadEnd,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockRequireAdminApi: vi.fn(),
  mockFileTypeFromBuffer: vi.fn(),
  mockSharpMeta: vi.fn(),
  mockSharpRotate: vi.fn(),
  mockSharpToBuffer: vi.fn(),
  mockBucketOpenUploadStream: vi.fn(),
  mockUploadOn: vi.fn(),
  mockUploadEnd: vi.fn(),
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

const mockSharpInstance = {
  metadata: mockSharpMeta,
  rotate: mockSharpRotate,
  toBuffer: mockSharpToBuffer,
};

const mockUploadStream = {
  id: { toString: () => "gridfs_photo_id_123" },
  on: mockUploadOn,
  end: mockUploadEnd,
};

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: mockRequireAdminApi,
}));
vi.mock("@/lib/gridfs", () => ({
  getEncryptedPhotosBucket: vi.fn().mockResolvedValue({
    openUploadStream: mockBucketOpenUploadStream,
  }),
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,
}));
vi.mock("file-type", () => ({ fileTypeFromBuffer: mockFileTypeFromBuffer }));
vi.mock("sharp", () => ({
  default: vi.fn().mockImplementation(() => mockSharpInstance),
}));

import { POST } from "@/app/api/admin/photos/route";
import { decryptBytes } from "@/lib/content-encryption";

function buildFormRequest(file: File | null): NextRequest {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new NextRequest(new URL("http://localhost:3000/api/admin/photos"), {
    method: "POST",
    body: formData,
  });
}

function makeJpegFile(size = 1024): File {
  const buf = new Uint8Array(size);
  return new File([buf], "photo.jpg", { type: "image/jpeg" });
}

function base64urlToBuffer(b64url: string): Buffer {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64");
}

describe("Admin Photos API — POST /api/admin/photos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdminApi.mockResolvedValue({
      id: "admin-1",
      email: "admin@test.com",
      role: "owner",
    });
    mockRateLimit.mockResolvedValue(null);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });
    mockSharpMeta.mockResolvedValue({ width: 800, height: 600 });
    mockSharpRotate.mockReturnValue(mockSharpInstance);
    // Sharp returns a known plaintext buffer — encrypting this gives us a
    // verifiable ciphertext we can decrypt later in the test.
    mockSharpToBuffer.mockResolvedValue(Buffer.from("PHOTO PLAINTEXT BYTES"));
    mockUploadOn.mockImplementation((event: string, cb: () => void) => {
      if (event === "finish") setTimeout(cb, 0);
      return mockUploadStream;
    });
    mockBucketOpenUploadStream.mockReturnValue(mockUploadStream);
  });

  // -------------------------------------------------------
  // Auth / validation
  // -------------------------------------------------------
  it("requires admin auth (delegates to requireAdminApi)", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdminApi.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await POST(buildFormRequest(makeJpegFile()));
    expect(res.status).toBe(401);
  });

  it("honors rate-limit return value", async () => {
    const { NextResponse } = await import("next/server");
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
    );
    const res = await POST(buildFormRequest(makeJpegFile()));
    expect(res.status).toBe(429);
  });

  it("returns 400 when no file is provided", async () => {
    const res = await POST(buildFormRequest(null));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("No file provided");
  });

  it("returns 422 for disallowed claimed MIME type", async () => {
    const pdf = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
    const res = await POST(buildFormRequest(pdf));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/Invalid file type/i);
  });

  it("returns 422 when file exceeds size cap", async () => {
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "big.jpg", {
      type: "image/jpeg",
    });
    const res = await POST(buildFormRequest(huge));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/max 5MB/i);
  });

  it("rejects files whose magic bytes don't match the claimed MIME", async () => {
    mockFileTypeFromBuffer.mockResolvedValueOnce(null);
    const res = await POST(buildFormRequest(makeJpegFile()));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/does not match/i);
  });

  it("rejects images with dimensions over 8192px", async () => {
    mockSharpMeta.mockResolvedValueOnce({ width: 9000, height: 600 });
    const res = await POST(buildFormRequest(makeJpegFile()));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/Image too large/);
  });

  // -------------------------------------------------------
  // Encryption-at-rest contract
  // -------------------------------------------------------
  it("encrypts the bytes before writing to GridFS — plaintext never persisted", async () => {
    const res = await POST(buildFormRequest(makeJpegFile()));
    expect(res.status).toBe(201);

    // The bytes passed to GridFS.end() must NOT equal the original plaintext.
    expect(mockUploadEnd).toHaveBeenCalledTimes(1);
    const written = mockUploadEnd.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(written.equals(Buffer.from("PHOTO PLAINTEXT BYTES"))).toBe(false);
    // AES-256-GCM overhead is IV(12) + tag(16) = 28 bytes
    expect(written.length).toBe("PHOTO PLAINTEXT BYTES".length + 28);
  });

  it("returns a DEK that successfully decrypts the GridFS ciphertext", async () => {
    const res = await POST(buildFormRequest(makeJpegFile()));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.gridFsId).toBe("gridfs_photo_id_123");
    expect(typeof body.dek).toBe("string");
    expect(body.mime).toBe("image/jpeg");

    // Round-trip: take the ciphertext that was written + the returned DEK
    // and confirm the original plaintext comes back. This is the strongest
    // end-to-end guarantee — if it fails, the photo is unrecoverable.
    const ciphertext = mockUploadEnd.mock.calls[0][0] as Buffer;
    const dek = base64urlToBuffer(body.dek);
    expect(dek.length).toBe(32);
    const decrypted = decryptBytes(ciphertext, dek);
    expect(decrypted.equals(Buffer.from("PHOTO PLAINTEXT BYTES"))).toBe(true);
  });

  it("does not include the DEK in the GridFS metadata", async () => {
    await POST(buildFormRequest(makeJpegFile()));
    expect(mockBucketOpenUploadStream).toHaveBeenCalledTimes(1);
    const [, opts] = mockBucketOpenUploadStream.mock.calls[0];
    expect(JSON.stringify(opts)).not.toMatch(/dek/i);
  });

  it("generates a fresh DEK per upload (no DEK reuse across requests)", async () => {
    const res1 = await POST(buildFormRequest(makeJpegFile()));
    const body1 = await res1.json();
    const res2 = await POST(buildFormRequest(makeJpegFile()));
    const body2 = await res2.json();
    expect(body1.dek).not.toBe(body2.dek);
  });
});
