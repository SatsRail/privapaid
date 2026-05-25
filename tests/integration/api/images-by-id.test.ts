import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";
import { createChannel, createMedia } from "../../helpers/factories";

import { GET } from "@/app/api/images/[id]/route";

function buildRequest(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(new URL(`http://localhost:3000/api/images/${id}`), {
    method: "GET",
  });
  return [req, { params: Promise.resolve({ id }) }];
}

describe("GET /api/images/[id]", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.restoreAllMocks();
  });

  it("returns 400 for an empty image id", async () => {
    const [req, ctx] = buildRequest("");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid image ID");
  });

  it("returns 404 when image not found in either table", async () => {
    const [req, ctx] = buildRequest("does-not-exist");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Image not found");
  });

  it("returns a PreviewImage with the stored MIME type", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const imageData = Buffer.from("preview-image-bytes");
    const preview = await prisma.previewImage.create({
      data: {
        mediaId: media.id,
        bytes: imageData,
        mimeType: "image/png",
        position: 0,
      },
      select: { id: true },
    });

    const [req, ctx] = buildRequest(preview.id);
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(imageData.length));
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toBe(`"${preview.id}"`);

    const responseBuffer = Buffer.from(await res.arrayBuffer());
    expect(responseBuffer.equals(imageData)).toBe(true);
  });

  it("returns an EncryptedPhotoBlob row with its stored MIME type", async () => {
    const imageData = Buffer.from("blob-bytes");
    const blob = await prisma.encryptedPhotoBlob.create({
      data: { bytes: imageData, mimeType: "image/jpeg" },
      select: { id: true },
    });

    const [req, ctx] = buildRequest(blob.id);
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    // Unlike the GridFS-era route, /api/images/[id] now serves the stored
    // MIME type rather than falling back to application/octet-stream.
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("ETag")).toBe(`"${blob.id}"`);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(imageData)).toBe(true);
  });

  it("prefers PreviewImage when both tables somehow have the same id", async () => {
    // Both tables use cuid() for ids — collisions are astronomically unlikely
    // in practice, but the route encodes a lookup order. Force a collision by
    // creating an EncryptedPhotoBlob with an id we control and inserting a
    // PreviewImage row with the same id. We use Prisma's raw `id` field —
    // both models allow client-supplied ids.
    const sharedId = "shared-id-for-test-only";
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    await prisma.previewImage.create({
      data: {
        id: sharedId,
        mediaId: media.id,
        bytes: Buffer.from("preview-wins"),
        mimeType: "image/png",
      },
    });
    await prisma.encryptedPhotoBlob.create({
      data: {
        id: sharedId,
        bytes: Buffer.from("blob-loses"),
        mimeType: "image/jpeg",
      },
    });

    const [req, ctx] = buildRequest(sharedId);
    const res = await GET(req, ctx);
    const buf = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(buf.equals(Buffer.from("preview-wins"))).toBe(true);
  });

  it("returns 500 when the PreviewImage lookup throws", async () => {
    const spy = vi
      .spyOn(prisma.previewImage, "findUnique")
      .mockRejectedValueOnce(new Error("DB error"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const [req, ctx] = buildRequest("anything");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to serve image");

    spy.mockRestore();
    errSpy.mockRestore();
  });

  it("returns 500 when the EncryptedPhotoBlob lookup throws", async () => {
    const spy = vi
      .spyOn(prisma.encryptedPhotoBlob, "findUnique")
      .mockRejectedValueOnce(new Error("DB error"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const [req, ctx] = buildRequest("anything");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to serve image");

    spy.mockRestore();
    errSpy.mockRestore();
  });
});
