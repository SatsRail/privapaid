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
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockRateLimit } = vi.hoisted(() => ({
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

import { GET } from "@/app/api/envelopes/[id]/route";

function buildRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(new URL(`http://localhost:3000/api/envelopes/${id}`), {
    method: "GET",
  });
  return [req, { params: Promise.resolve({ id }) }];
}

describe("GET /api/envelopes/[id]", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue(null);
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns 400 for an empty photo id", async () => {
    // An empty id is the only id the route validates explicitly. cuid
    // validation is otherwise lighter than ObjectId, so any non-empty string
    // simply falls through to the lookup and returns 404 if not found.
    const [req, ctx] = buildRequest("");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Invalid envelope ID/i);
  });

  it("returns 404 when the encrypted photo is missing", async () => {
    const [req, ctx] = buildRequest("missing-photo-id");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe("Envelope not found");
  });

  it("streams ciphertext with application/octet-stream — not an image MIME", async () => {
    // Critical: the response Content-Type must NOT reveal the underlying image
    // type. The body is AES-GCM ciphertext, not an image — labelling it
    // `image/jpeg` would tempt browsers to try and render it (and could give
    // false confidence about what's being served).
    const ciphertext = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    const blob = await prisma.mediaEnvelope.create({
      data: { bytes: ciphertext, mimeType: "image/jpeg" },
      select: { id: true },
    });

    const [req, ctx] = buildRequest(blob.id);
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Length")).toBe(String(ciphertext.length));
    expect(res.headers.get("ETag")).toBe(`"${blob.id}"`);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(ciphertext)).toBe(true);
  });

  it("returns the full byte payload regardless of size", async () => {
    // A single response body — Prisma returns the full buffer, not chunks.
    const payload = Buffer.concat([
      Buffer.from([0x01, 0x02]),
      Buffer.from([0x03, 0x04, 0x05]),
    ]);
    const blob = await prisma.mediaEnvelope.create({
      data: { bytes: payload, mimeType: "image/png" },
      select: { id: true },
    });

    const [req, ctx] = buildRequest(blob.id);
    const res = await GET(req, ctx);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(payload)).toBe(true);
  });

  it("honors the rate limiter", async () => {
    const { NextResponse } = await import("next/server");
    mockRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
    );
    // Seed a row so a non-rate-limited request would otherwise succeed.
    const blob = await prisma.mediaEnvelope.create({
      data: { bytes: Buffer.from([0x00]), mimeType: "image/png" },
      select: { id: true },
    });
    const [req, ctx] = buildRequest(blob.id);
    const res = await GET(req, ctx);
    expect(res.status).toBe(429);
  });

  it("does not gate on auth — encrypted bytes are safe to serve publicly", async () => {
    // Test the contract by simply NOT mocking auth: if the route required auth
    // it would 401 here. Confirm it returns the bytes.
    const ciphertext = Buffer.from([0xaa, 0xbb]);
    const blob = await prisma.mediaEnvelope.create({
      data: { bytes: ciphertext, mimeType: "image/jpeg" },
      select: { id: true },
    });

    const [req, ctx] = buildRequest(blob.id);
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
  });

  it("returns 500 with a structured error when the DB lookup throws", async () => {
    const spy = vi
      .spyOn(prisma.mediaEnvelope, "findUnique")
      .mockRejectedValueOnce(new Error("db broke"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const [req, ctx] = buildRequest("anything");
    const res = await GET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/Failed to serve envelope/i);

    spy.mockRestore();
    errSpy.mockRestore();
  });
});
