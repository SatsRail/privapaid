import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { encryptSourceUrl, encryptBytes } from "@/lib/content-encryption";
import {
  base64urlToBytes,
  bytesToBase64url,
  clientDecryptBlob,
  clientDecryptBytesWithKey,
  genProductKey,
} from "../../helpers/crypto";

/**
 * End-to-end smoke tests pinning the cryptographic contract between
 * server-side encryption (Node `crypto`) and client-side decryption
 * (Web Crypto via `crypto.subtle`).
 *
 * These tests catch regressions where one side (e.g. Node) silently
 * changes IV/tag layout, AAD encoding, or base64url normalization but
 * the other side (Web Crypto in the browser) still decodes successfully
 * for some inputs and not others — exactly the failure mode that produces
 * "Payment received, couldn't unlock" after a real Lightning payment.
 *
 * Article: source_url string encrypted directly under product key.
 * Photo:   per-photo DEK wrapped under product key (envelope), bytes
 *          encrypted under the DEK and persisted to GridFS.
 */

const PRODUCT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Server→client decryption contract", () => {
  it("article: source_url markdown round-trips through Node encrypt + Web Crypto decrypt", async () => {
    const productKey = genProductKey();
    const articleBody = [
      "# Lightning in a bottle",
      "",
      "A short markdown article.",
      "",
      "- bullet **bold**",
      "- [link](https://example.com)",
      "",
      "```",
      "code block",
      "```",
      "",
      "Unicode: café, 中文, 🤝",
    ].join("\n");

    // Server side — exactly what /api/admin/media/[id]/create-product does
    const encryptedBlob = encryptSourceUrl(articleBody, productKey, PRODUCT_ID);

    // Client side — exactly what PaymentWall.resolveContent does for
    // non-photo media (just decryptBlob).
    const decrypted = await clientDecryptBlob(encryptedBlob, productKey, PRODUCT_ID);
    const recovered = new TextDecoder().decode(decrypted);

    expect(recovered).toBe(articleBody);
  });

  it("article: large body (~100KB) still round-trips", async () => {
    const productKey = genProductKey();
    // Articles can be long. Schema cap is 500KB; 100KB is a comfortable
    // realistic size that exercises chunked AES-GCM.
    const big = "x".repeat(100_000);
    const blob = encryptSourceUrl(big, productKey, PRODUCT_ID);
    const decrypted = await clientDecryptBlob(blob, productKey, PRODUCT_ID);
    expect(new TextDecoder().decode(decrypted)).toBe(big);
  });

  it("article: wrong productId AAD fails decryption (binding is real)", async () => {
    const productKey = genProductKey();
    const blob = encryptSourceUrl("secret", productKey, PRODUCT_ID);
    await expect(
      clientDecryptBlob(blob, productKey, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeTruthy();
  });

  it("photo: envelope round-trip (DEK wrap → GridFS bytes → recover image)", async () => {
    const productKey = genProductKey();

    // Server side — /api/admin/photos generates a fresh DEK, encrypts the
    // bytes, and returns the DEK as base64url. /api/admin/media/[id]/create-product
    // then wraps that DEK under the product key.
    const dek = randomBytes(32);
    const photoBytes = Buffer.from(
      // A minimal PNG signature so detectMimeType would classify it as image/png
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("FAKE-IMAGE-PAYLOAD")])
    );
    const gridFsCiphertext = encryptBytes(photoBytes, dek);

    const dekBase64url = bytesToBase64url(dek);
    const wrappedDek = encryptSourceUrl(dekBase64url, productKey, PRODUCT_ID);

    // Client side — PaymentWall.resolveContent for media_type === "photo":
    // 1. decryptBlob on the wrapped DEK (with productId AAD) → 43-char DEK string
    const innerBytes = await clientDecryptBlob(wrappedDek, productKey, PRODUCT_ID);
    const recoveredDekBase64url = new TextDecoder().decode(innerBytes);
    expect(recoveredDekBase64url).toBe(dekBase64url);

    // 2. base64url-decode the DEK to 32 raw bytes
    const recoveredDek = base64urlToBytes(recoveredDekBase64url);
    expect(recoveredDek.length).toBe(32);
    expect(Buffer.compare(Buffer.from(recoveredDek), dek)).toBe(0);

    // 3. decryptBytesWithKey on the GridFS ciphertext (no AAD)
    const recovered = await clientDecryptBytesWithKey(
      new Uint8Array(gridFsCiphertext),
      recoveredDek
    );
    expect(Buffer.compare(Buffer.from(recovered), photoBytes)).toBe(0);
  });

  it("photo: cross-product isolation — product A's key cannot unwrap B's envelope", async () => {
    const keyA = genProductKey();
    const keyB = genProductKey();
    const dek = randomBytes(32);
    const dekStr = bytesToBase64url(dek);
    const wrappedForA = encryptSourceUrl(dekStr, keyA, PRODUCT_ID);

    await expect(clientDecryptBlob(wrappedForA, keyB, PRODUCT_ID)).rejects.toBeTruthy();
  });
});
