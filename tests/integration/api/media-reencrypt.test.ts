import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { createEnvelopeArtifacts } from "@/lib/media-envelope";
import { genProductKey } from "../../helpers/crypto";

/**
 * The media-scoped re-encrypt endpoint behind the edit-page "Re-encrypt keys"
 * button. It re-wraps the media's MediaProduct rows under the current envelope
 * DEK (the self-serve repair for "couldn't unlock the content"). Real crypto so
 * the success case is genuine; only the route boundaries are mocked.
 */

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/auth-helpers", () => ({
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "owner-1", email: "o@test.com", role: "owner" }),
}));
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test"),
}));

import { POST as reencryptMedia } from "@/app/api/admin/media/[id]/re-encrypt/route";
import { getMerchantKey } from "@/lib/merchant-key";
import { prisma } from "@/lib/prisma";

let refSeed = 9500;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function postReq(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/media/${id}/re-encrypt`, {
    method: "POST",
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/admin/media/[id]/re-encrypt", () => {
  beforeAll(async () => {
    await setupTestDB();
  });
  afterAll(async () => {
    await teardownTestDB();
  });
  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    vi.mocked(getMerchantKey).mockResolvedValue("sk_live_test");
  });

  async function seedMediaWithStaleProduct(productId: string, productKey: string) {
    const art = createEnvelopeArtifacts(Buffer.from("https://cdn.example.com/v.mp4", "utf8"));
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `rk-${nextRef()}`, name: "RK", active: true },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Video",
        mediaType: "video",
        envelope: {
          create: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bytes: art.bytes as any,
            mimeType: "text/url",
            wrappedDek: art.wrappedDek,
          },
        },
      },
    });
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: productId,
      encryptedSource: encryptSourceUrl("stale-value", productKey, productId),
    });
    return media.id;
  }

  it("re-keys the media's products and returns the summary (+ audit)", async () => {
    const productId = "prod_btn_ok";
    const productKey = genProductKey();
    mockSatsrailClient.getProductKey.mockResolvedValue({ key: productKey });
    const mediaId = await seedMediaWithStaleProduct(productId, productKey);

    const res = await reencryptMedia(postReq(mediaId), ctx(mediaId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 1, reencrypted: 1, errors: [] });
    expect(mockSatsrailClient.getProductKey).toHaveBeenCalledWith("sk_live_test", productId);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "media.reencrypt", targetId: mediaId })
    );
  });

  it("lifts a stale `error` status on a clean re-key", async () => {
    const productId = "prod_btn_status";
    const productKey = genProductKey();
    mockSatsrailClient.getProductKey.mockResolvedValue({ key: productKey });
    const mediaId = await seedMediaWithStaleProduct(productId, productKey);
    await prisma.media.update({
      where: { id: mediaId },
      data: { status: "error", statusReason: "integrity_auth_failed" },
    });

    const res = await reencryptMedia(postReq(mediaId), ctx(mediaId));
    expect(res.status).toBe(200);
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.status).toBe("ok");
    expect(media!.statusReason).toBeNull();
  });

  it("leaves the `error` status in place on a partial re-key", async () => {
    const productId = "prod_btn_status_partial";
    const productKey = genProductKey();
    const mediaId = await seedMediaWithStaleProduct(productId, productKey);
    await prisma.media.update({ where: { id: mediaId }, data: { status: "error" } });
    mockSatsrailClient.getProductKey.mockRejectedValue(new Error("portal down"));

    await reencryptMedia(postReq(mediaId), ctx(mediaId));
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.status).toBe("error");
  });

  it("returns 422 when no merchant key is configured", async () => {
    const productId = "prod_btn_nokey";
    const productKey = genProductKey();
    const mediaId = await seedMediaWithStaleProduct(productId, productKey);
    vi.mocked(getMerchantKey).mockResolvedValueOnce(null);

    const res = await reencryptMedia(postReq(mediaId), ctx(mediaId));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/merchant api key/i);
    expect(mockSatsrailClient.getProductKey).not.toHaveBeenCalled();
  });

  it("returns 422 with a helpful message when the media has no envelope", async () => {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `rk-${nextRef()}`, name: "RK", active: true },
    });
    const media = await prisma.media.create({
      data: { ref: nextRef(), channelId: channel.id, name: "No env", mediaType: "video" },
    });

    const res = await reencryptMedia(postReq(media.id), ctx(media.id));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/no envelope/i);
  });

  it("returns a partial summary (200) when SatsRail can't return a product key", async () => {
    const productId = "prod_btn_partial";
    const productKey = genProductKey();
    const mediaId = await seedMediaWithStaleProduct(productId, productKey);
    mockSatsrailClient.getProductKey.mockRejectedValue(new Error("portal down"));

    const res = await reencryptMedia(postReq(mediaId), ctx(mediaId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reencrypted).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].satsrailProductId).toBe(productId);
  });

  it("returns 404 for a missing media", async () => {
    const res = await reencryptMedia(postReq("cmnonexistent000"), ctx("cmnonexistent000"));
    expect(res.status).toBe(404);
  });
});
