import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createMediaProduct } from "../../helpers/factories";
import { mockSatsrailClient } from "../../helpers/mocks/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { decryptEnvelopePayload } from "@/lib/media-envelope";
import {
  base64urlToBytes,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
} from "../../helpers/crypto";

/**
 * Regression for the production incident: a url media that lost its envelope in
 * the EncryptedEnvelope→MediaEnvelope migration is re-saved on the edit page.
 * Saving mints a FRESH per-media DEK, so the pre-existing MediaProduct row (which
 * wraps the OLD value — pre-migration, the URL itself) goes stale. A buyer then
 * pays, the product key recovers the wrong key, and the viewer shows
 * "Payment received … couldn't unlock the content on this device" even though the
 * admin sees the correct URL in the form (the envelope decrypts fine under
 * CONTENT_KEK).
 *
 * This drives the REAL PATCH route with REAL crypto and runs the actual two-step
 * buyer decrypt (product key → MediaProduct.encryptedDek → media DEK → envelope
 * bytes → payload) to prove:
 *   1. without the re-key (no merchant key), the buyer path stays broken, and
 *   2. with the re-key, saving the URL makes the content unlock.
 *
 * Only the route's boundaries are mocked (auth, audit, merchant key, SatsRail
 * key fetch). The envelope + DEK + product-wrap crypto is all real.
 */

vi.mock("@/lib/satsrail", () => ({ satsrail: mockSatsrailClient }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAdminApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "a@test.com", role: "owner" }),
  requireOwnerApi: vi.fn().mockResolvedValue({ id: "admin-1", email: "a@test.com", role: "owner" }),
}));
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test"),
}));

import { PATCH as updateMedia } from "@/app/api/admin/media/[id]/route";
import { getMerchantKey } from "@/lib/merchant-key";
import { prisma } from "@/lib/prisma";

let refSeed = 9000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function patchRequest(mediaId: string, sourceUrl: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/admin/media/${mediaId}`, "http://localhost:3000"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: sourceUrl }),
    }
  );
}

describe("Edit-page URL re-save → buyer decrypt (real-crypto end-to-end)", () => {
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

  /**
   * Envelope-less url media + a MediaProduct row that wraps the OLD url under the
   * product key (the post-migration broken shape). Mirrors a previously-sold
   * video whose source must be re-supplied.
   */
  async function seedSoldButEnvelopeLess(opts: {
    oldUrl: string;
    productId: string;
    productKey: string;
  }) {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `vs-${nextRef()}`, name: "Video Stream", active: true },
    });
    const media = await prisma.media.create({
      data: { ref: nextRef(), channelId: channel.id, name: "Stream video", mediaType: "video", position: 1 },
    });
    const staleCiphertext = encryptSourceUrl(opts.oldUrl, opts.productKey, opts.productId);
    await createMediaProduct({
      mediaId: media.id,
      satsrailProductId: opts.productId,
      encryptedSource: staleCiphertext,
    });
    return { mediaId: media.id };
  }

  /** The exact two-step the browser runs after payment. Throws if it can't unlock. */
  async function buyerUnlock(mediaId: string, productKey: string, productId: string): Promise<string> {
    const row = await prisma.mediaProduct.findFirst({ where: { mediaId } });
    const dekBase64url = new TextDecoder().decode(
      await clientDecryptBlob(row!.encryptedDek, productKey, productId)
    );
    const envelope = await prisma.mediaEnvelope.findUnique({
      where: { mediaId },
      select: { bytes: true },
    });
    const payload = await clientDecryptBytesWithKey(
      Uint8Array.from(envelope!.bytes),
      base64urlToBytes(dekBase64url)
    );
    return new TextDecoder().decode(payload);
  }

  it("WITHOUT the re-key (no merchant key), the mint succeeds but the buyer still can't unlock — the reported bug", async () => {
    const productId = "prod_vs_nokey";
    const productKey = genProductKey();
    mockSatsrailClient.getProductKey.mockResolvedValue({ key: productKey });
    const { mediaId } = await seedSoldButEnvelopeLess({
      oldUrl: "https://old.example.com/v.mp4",
      productId,
      productKey,
    });

    // No merchant key on this save ⇒ the route mints the envelope but skips the
    // product re-key (and does not fail the save).
    vi.mocked(getMerchantKey).mockResolvedValueOnce(null);
    const res = await updateMedia(patchRequest(mediaId, "https://cdn.example.com/new.mp4"), {
      params: Promise.resolve({ id: mediaId }),
    });
    expect(res.status).toBe(200);

    // The admin sees the correct URL (envelope decrypts under CONTENT_KEK) ...
    const envelope = await prisma.mediaEnvelope.findUnique({ where: { mediaId } });
    expect(decryptEnvelopePayload(envelope!).toString("utf8")).toBe("https://cdn.example.com/new.mp4");
    // ... but the stale product row was never re-keyed, so the buyer two-step fails.
    expect(mockSatsrailClient.getProductKey).not.toHaveBeenCalled();
    await expect(buyerUnlock(mediaId, productKey, productId)).rejects.toThrow();
  });

  it("WITH the re-key, re-saving the URL makes the two-step buyer decrypt unlock the content", async () => {
    const productId = "prod_vs_ok";
    const productKey = genProductKey();
    mockSatsrailClient.getProductKey.mockResolvedValue({ key: productKey });
    const { mediaId } = await seedSoldButEnvelopeLess({
      oldUrl: "https://old.example.com/v.mp4",
      productId,
      productKey,
    });

    const newUrl = "https://cdn.example.com/secret.mp4";
    const res = await updateMedia(patchRequest(mediaId, newUrl), {
      params: Promise.resolve({ id: mediaId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reencrypt).toMatchObject({ total: 1, reencrypted: 1, errors: [] });

    // The route fetched the product key and re-wrapped the row ...
    expect(mockSatsrailClient.getProductKey).toHaveBeenCalledWith("sk_live_test", productId);
    // ... so the full buyer path now recovers the content.
    expect(await buyerUnlock(mediaId, productKey, productId)).toBe(newUrl);
  });
});
