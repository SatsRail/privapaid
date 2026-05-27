import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { satsrail } from "@/lib/satsrail";
import {
  encryptBytes,
  encryptSourceUrl,
  decryptBytes,
} from "@/lib/content-encryption";
import { wrapDek, unwrapDek, unwrapDekToBase64url } from "@/lib/content-dek";
import { schemas } from "@/lib/validate";
import {
  mediaBlobSchema,
  parseMediaBlob,
  plaintextForEncryption,
  type MediaBlob,
} from "@/lib/schemas/media-blob";

// ─── Types ─────────────────────────────────────────────────────────

export interface ImportError {
  entity: string;
  name: string;
  error: string;
}

export interface EntityResults {
  created: number;
  updated: number;
  errors: ImportError[];
}

export type ImportPayload = z.infer<typeof schemas.importPayload>;
export type ImportChannel = ImportPayload["channels"][number];
export type ImportMedia = ImportChannel["media"][number];
export type ImportMediaWithProduct = ImportMedia & { product: NonNullable<ImportMedia["product"]> };
export type ImportChannelProduct = NonNullable<ImportChannel["product"]>;

export type SendProgressFn = (phase: string, item: string, status: "processing" | "done" | "error", error?: string) => Promise<void>;
export type StatusFn = (detail: string) => Promise<void>;

// ─── Constants ─────────────────────────────────────────────────────

export const MAX_MEDIA_ITEMS = 100;
const ARTICLE_MIME = "text/markdown; charset=utf-8";

// ─── Utility Functions ─────────────────────────────────────────────

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export function isExternalRefTaken(err: unknown): boolean {
  return err instanceof Error && err.message.includes("External ref has already been taken");
}

// Retry a function when SatsRail returns 429 (rate limited)
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;

      const msg = err instanceof Error ? err.message : "";
      const match = msg.match(/429.*?retry.after.*?(\d+)/i) || msg.match(/rate.limit.*?(\d+)/i);
      if (!match) throw err; // Not a rate limit error, don't retry

      const waitSeconds = Math.min(parseInt(match[1], 10) || 5, 30);
      await delay((waitSeconds + 1) * 1000);
    }
  }
  throw new Error("withRetry: unreachable");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── API Throttle ─────────────────────────────────────────────────

// Centralised rate limiter: enforces a minimum gap between SatsRail API
// calls so we stay under Rack Attack limits (Free tier = 60 req/min).
// One instance is created per import invocation.
export class ApiThrottle {
  private lastCallTime = 0;
  constructor(private minGapMs = 1100) {}

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minGapMs) {
      await delay(this.minGapMs - elapsed);
    }
    this.lastCallTime = Date.now();
  }
}

export function createApiThrottle(minGapMs = 1100): ApiThrottle {
  return new ApiThrottle(minGapMs);
}

// ─── Blob construction for import payloads ─────────────────────────

function bytesToBase64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build the Media.blob payload and the per-product plaintext for an import
 * entry. For articles this generates a fresh DEK on create and reuses the
 * existing DEK on update (so per-product blobs don't need re-encryption when
 * only the markdown body changes).
 *
 * Returns `productPlaintext` — what should be wrapped under each product key:
 *   url:     the URL string itself
 *   article: the raw DEK as base64url (post-product-decrypt, the viewer uses
 *            it to decrypt the EncryptedEnvelope bytes)
 *
 * Photos can't be imported via JSON (no way to produce ciphertext + DEK
 * server-side from a URL).
 */
export async function buildArtifactsForImport(
  mData: ImportMedia,
  existingBlob: unknown | null
): Promise<{ blob: MediaBlob; productPlaintext: string }> {
  if (mData.media_type === "article") {
    const existingArticle = (() => {
      if (!existingBlob) return null;
      try {
        const parsed = parseMediaBlob(existingBlob);
        return parsed.kind === "article" ? parsed : null;
      } catch {
        return null;
      }
    })();

    if (existingArticle) {
      // Re-encrypt the envelope bytes under the existing DEK. The blob
      // shape stays identical, so per-product blobs don't need touching
      // and we still return the same `productPlaintext` (the raw DEK).
      const dekBytes = unwrapDek(existingArticle.encryptedDek);
      const ciphertext = encryptBytes(Buffer.from(mData.source_url, "utf8"), dekBytes);
      await prisma.encryptedEnvelope.update({
        where: { id: existingArticle.envelopeId },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bytes: ciphertext as any,
          mimeType: ARTICLE_MIME,
        },
      });
      return {
        blob: existingArticle,
        productPlaintext: bytesToBase64url(dekBytes),
      };
    }

    // Fresh DEK + envelope row for a new article.
    const dekBytes = randomBytes(32);
    const ciphertext = encryptBytes(Buffer.from(mData.source_url, "utf8"), dekBytes);
    const encryptedDek = wrapDek(dekBytes);
    const envelope = await prisma.encryptedEnvelope.create({
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: ciphertext as any,
        mimeType: ARTICLE_MIME,
      },
      select: { id: true },
    });
    return {
      blob: {
        kind: "article",
        envelopeId: envelope.id,
        encryptedDek,
        mimeType: ARTICLE_MIME,
      },
      productPlaintext: bytesToBase64url(dekBytes),
    };
  }

  return {
    blob: { kind: "url", url: mData.source_url },
    productPlaintext: mData.source_url,
  };
}

// ─── SatsRail Product Helpers ──────────────────────────────────────

// Create or find existing product type by external_ref (check-first approach)
export async function createProductSafeType(
  sk: string,
  name: string,
  externalRef: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<{ id: string }> {
  // Check if product type already exists
  await onStatus?.("Checking existing product types...");
  await api.throttle();
  const { data } = await satsrail.listProductTypes(sk);
  const existing = data.find((pt) => pt.external_ref === externalRef);
  if (existing) return existing;

  // Not found — create
  await onStatus?.("Creating product type on SatsRail...");
  await api.throttle();
  return await withRetry(() => satsrail.createProductType(sk, { name, external_ref: externalRef }));
}

// Create or find existing product by external_ref (check-first approach)
export async function createProductSafe(
  sk: string,
  data: {
    name: string;
    price_cents: number;
    currency?: string;
    access_duration_seconds?: number;
    product_type_id?: string;
    external_ref?: string;
  },
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<{ id: string }> {
  // Check if product already exists by external_ref
  if (data.external_ref) {
    await onStatus?.("Checking existing product on SatsRail...");
    await api.throttle();
    const { data: products } = await satsrail.listProducts(sk, {
      external_ref_eq: data.external_ref,
    });
    const existing = products.find((p) => p.external_ref === data.external_ref);
    if (existing) {
      // Update metadata if changed
      await onStatus?.("Updating product on SatsRail...");
      await api.throttle();
      await withRetry(() => satsrail.updateProduct(sk, existing.id, {
        name: data.name,
        price_cents: data.price_cents,
        access_duration_seconds: data.access_duration_seconds,
      }));
      return existing;
    }
  }

  // Product doesn't exist — create
  await onStatus?.("Creating product on SatsRail...");
  await api.throttle();
  return await withRetry(() => satsrail.createProduct(sk, data));
}

// Get product key; if 404 (orphaned product), create a fresh product and get its key
export async function getProductKeySafe(
  sk: string,
  productId: string,
  productData: {
    name: string;
    price_cents: number;
    currency?: string;
    access_duration_seconds?: number;
    product_type_id?: string;
    external_ref?: string;
  },
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<{ productId: string; key: string; key_fingerprint: string }> {
  try {
    await onStatus?.("Fetching encryption key...");
    await api.throttle();
    const result = await withRetry(() => satsrail.getProductKey(sk, productId));
    return { productId, ...result };
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      await onStatus?.("Recreating orphaned product...");
      const newProduct = await createProductSafe(sk, productData, api, onStatus);
      await onStatus?.("Fetching encryption key...");
      await api.throttle();
      const result = await withRetry(() => satsrail.getProductKey(sk, newProduct.id));
      return { productId: newProduct.id, ...result };
    }
    throw err;
  }
}

// ─── Media-scoped product (direct sale) ────────────────────────────

/**
 * Create or update a media-scoped Product + its single MediaEncryptedBlob row.
 * `productPlaintext` is the value to encrypt under the product key: source
 * URL for url-backed media, raw DEK (base64url) for envelope-encrypted media.
 */
export async function createEncryptedMediaProduct(
  sk: string,
  productData: {
    name: string;
    price_cents: number;
    currency?: string;
    access_duration_seconds?: number;
    product_type_id?: string;
    external_ref: string;
  },
  mediaId: string,
  productPlaintext: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const satsrailProduct = await createProductSafe(sk, productData, api, onStatus);
  const keyResult = await getProductKeySafe(sk, satsrailProduct.id, productData, api, onStatus);

  await onStatus?.("Encrypting content...");
  const encryptedSource = encryptSourceUrl(productPlaintext, keyResult.key, keyResult.productId);

  const cachedFields = {
    keyFingerprint: keyResult.key_fingerprint,
    productName: productData.name,
    productPriceCents: productData.price_cents,
    productCurrency: productData.currency,
    productAccessDurationSeconds: productData.access_duration_seconds,
    productExternalRef: productData.external_ref,
    productStatus: "active",
    syncedAt: new Date(),
  };

  await onStatus?.("Saving encrypted product record...");
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.upsert({
      where: { mediaId },
      create: {
        satsrailProductId: keyResult.productId,
        mediaId,
        ...cachedFields,
      },
      update: {
        satsrailProductId: keyResult.productId,
        ...cachedFields,
      },
    });

    await tx.mediaEncryptedBlob.upsert({
      where: { productId_mediaId: { productId: product.id, mediaId } },
      create: {
        productId: product.id,
        mediaId,
        encryptedSource,
        keyFingerprint: keyResult.key_fingerprint,
      },
      update: {
        encryptedSource,
        keyFingerprint: keyResult.key_fingerprint,
      },
    });
  });
}

// ─── Channel Product Type Helpers ──────────────────────────────────

export async function ensureChannelProductType(
  sk: string,
  existingDoc: { id: string; satsrailProductTypeId: string | null },
  chData: ImportChannel,
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const hasProducts = chData.media?.some((m: { product?: unknown }) => m.product);
  if (existingDoc.satsrailProductTypeId || !hasProducts) return;

  try {
    const ch = await prisma.channel.findUnique({
      where: { id: existingDoc.id },
      select: { ref: true },
    });
    const productType = await createProductSafeType(sk, chData.name, `ch_${ch?.ref || existingDoc.id}`, api, onStatus);
    existingDoc.satsrailProductTypeId = productType.id;
    await prisma.channel.update({
      where: { id: existingDoc.id },
      data: { satsrailProductTypeId: productType.id },
    });
  } catch (err) {
    errors.push({ entity: "channel", name: chData.name, error: `Product type creation failed: ${errorMsg(err)}` });
  }
}

export async function tryCreateProductType(
  sk: string,
  name: string,
  externalRef: string,
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<string | null> {
  try {
    const productType = await createProductSafeType(sk, name, externalRef, api, onStatus);
    return productType.id;
  } catch (err) {
    errors.push({ entity: "channel", name, error: `Product type creation failed: ${errorMsg(err)}` });
    return null;
  }
}

// ─── Media Helpers ─────────────────────────────────────────────────

/**
 * Update an existing media-scoped Product's cached metadata, and re-encrypt
 * the single MediaEncryptedBlob row when the product plaintext has changed.
 */
export async function updateExistingProduct(
  sk: string,
  existingProduct: { id: string; satsrailProductId: string },
  mData: ImportMediaWithProduct,
  newProductPlaintext: string,
  plaintextChanged: boolean,
  channelDoc: { satsrailProductTypeId: string | null },
  externalRef: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  await onStatus?.("Updating product on SatsRail...");
  await api.throttle();
  await withRetry(() => satsrail.updateProduct(sk, existingProduct.satsrailProductId, {
    name: mData.product.name,
    price_cents: mData.product.price_cents,
    access_duration_seconds: mData.product.access_duration_seconds,
  }));

  const cachedFields = {
    productName: mData.product.name,
    productPriceCents: mData.product.price_cents,
    productCurrency: mData.product.currency,
    productAccessDurationSeconds: mData.product.access_duration_seconds,
    productExternalRef: externalRef,
    syncedAt: new Date(),
  };

  if (!plaintextChanged) {
    // Refresh cached metadata even when content didn't change, so future
    // exports carry the canonical external_ref rather than the fallback.
    await prisma.product.update({
      where: { id: existingProduct.id },
      data: cachedFields,
    });
    return;
  }

  const keyResult = await getProductKeySafe(sk, existingProduct.satsrailProductId, {
    name: mData.product.name, price_cents: mData.product.price_cents,
    currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
    product_type_id: channelDoc.satsrailProductTypeId || undefined, external_ref: externalRef,
  }, api, onStatus);

  await onStatus?.("Re-encrypting content...");
  const encryptedSource = encryptSourceUrl(newProductPlaintext, keyResult.key, keyResult.productId);

  await prisma.$transaction([
    prisma.product.update({
      where: { id: existingProduct.id },
      data: {
        satsrailProductId: keyResult.productId,
        keyFingerprint: keyResult.key_fingerprint,
        ...cachedFields,
      },
    }),
    prisma.mediaEncryptedBlob.updateMany({
      where: { productId: existingProduct.id },
      data: {
        encryptedSource,
        keyFingerprint: keyResult.key_fingerprint,
      },
    }),
  ]);
}

// Handle product for an existing media item (update or create)
export async function handleExistingMediaProduct(
  sk: string,
  mData: ImportMediaWithProduct,
  existingMedia: { id: string; ref: number },
  productPlaintext: string,
  plaintextChanged: boolean,
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const existingProduct = await prisma.product.findUnique({
    where: { mediaId: existingMedia.id },
  });
  const externalRef = mData.product.external_ref || `md_${existingMedia.ref}`;

  if (existingProduct) {
    try {
      await updateExistingProduct(sk, existingProduct, mData, productPlaintext, plaintextChanged, channelDoc, externalRef, api, onStatus);
    } catch (err) {
      errors.push({ entity: "media_product", name: mData.name, error: `Product update failed: ${errorMsg(err)}` });
    }
    return;
  }

  if (!channelDoc.satsrailProductTypeId) return;

  try {
    await createEncryptedMediaProduct(sk, {
      name: mData.product.name, price_cents: mData.product.price_cents,
      currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
      product_type_id: channelDoc.satsrailProductTypeId, external_ref: externalRef,
    }, existingMedia.id, productPlaintext, api, onStatus);
  } catch (err) {
    errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
  }
}

/**
 * Read the "source plaintext" stored on a Media row — the value that should
 * match `mData.source_url` for change detection. For envelope-encrypted
 * media we decrypt the envelope to recover the original markdown body.
 */
async function sourceFromMediaRow(media: { blob: unknown }): Promise<string> {
  const blob = parseMediaBlob(media.blob);
  if (blob.kind === "url") return blob.url;
  if (blob.kind === "article") {
    const envelope = await prisma.encryptedEnvelope.findUnique({
      where: { id: blob.envelopeId },
      select: { bytes: true },
    });
    if (!envelope) return "";
    const dek = unwrapDek(blob.encryptedDek);
    return decryptBytes(envelope.bytes as Buffer, dek).toString("utf8");
  }
  // photo: opaque envelopeId; not import-supported but keep symmetry
  return blob.envelopeId;
}

/**
 * Read what should be encrypted under each product key for a Media row.
 * Mirrors plaintextForEncryption but with the DEK unwrapped for envelope
 * kinds.
 */
function productPlaintextFromMediaRow(media: { blob: unknown }): string {
  const blob = parseMediaBlob(media.blob);
  if (blob.kind === "photo" || blob.kind === "article") {
    return unwrapDekToBase64url(blob.encryptedDek);
  }
  return plaintextForEncryption(blob);
}

// Find existing media by ref or name
export async function findExistingMedia(mData: ImportMedia, channelId: string) {
  const byRef = mData.ref
    ? await prisma.media.findFirst({
        where: { ref: mData.ref, channelId, deletedAt: null },
      })
    : null;
  if (byRef) return byRef;

  return prisma.media.findFirst({
    where: { channelId, name: mData.name, deletedAt: null },
  });
}

export async function updateExistingMedia(
  sk: string | null,
  mData: ImportMedia,
  existingMedia: { id: string; ref: number; blob: unknown },
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const oldSource = await sourceFromMediaRow(existingMedia);
  const sourceChanged = Boolean(mData.source_url && mData.source_url !== oldSource);
  const { blob: newBlob, productPlaintext } = await buildArtifactsForImport(mData, existingMedia.blob);

  await onStatus?.("Updating media record...");
  await prisma.media.update({
    where: { id: existingMedia.id },
    data: {
      name: mData.name,
      description: mData.description || "",
      blob: newBlob,
      mediaType: mData.media_type || "video",
      thumbnailUrl: mData.thumbnail_url || "",
      ...(mData.preview_image_urls?.length ? { previewImageUrls: mData.preview_image_urls } : {}),
      ...(mData.position !== undefined ? { position: mData.position } : {}),
    },
  });

  if (mData.product && sk) {
    // For articles, the per-product blob's plaintext is the raw DEK — which
    // doesn't change when the markdown body changes. For url media, the
    // plaintext IS the URL. So per-product re-encryption is needed only when
    // the productPlaintext itself changed.
    const oldProductPlaintext = productPlaintextFromMediaRow(existingMedia);
    const productPlaintextChanged = sourceChanged && oldProductPlaintext !== productPlaintext;
    await handleExistingMediaProduct(
      sk,
      mData as ImportMediaWithProduct,
      existingMedia,
      productPlaintext,
      productPlaintextChanged,
      channelDoc,
      errors,
      api,
      onStatus
    );
  }
}

export async function createNewMedia(
  sk: string | null,
  mData: ImportMedia,
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  // Photo media is unsupported in JSON import flow: photos require uploading
  // raw bytes through /api/admin/photos (which generates the per-photo DEK
  // and writes ciphertext to the EncryptedEnvelope table). A URL-based
  // import has no way to produce the encrypted bytes or the DEK envelope, so
  // the imported row would be unviewable.
  if (mData.media_type === "photo") {
    throw new Error(
      "Photo media cannot be imported from JSON — upload via /api/admin/photos to encrypt the bytes."
    );
  }

  await onStatus?.("Saving media record...");
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channelDoc.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const { blob, productPlaintext } = await buildArtifactsForImport(mData, null);

  // If the import payload specifies a `ref`, honor it (preserves the source
  // identity on replay/restore). Otherwise Postgres's autoincrement assigns
  // one. Either way we read `media.ref` back for the SatsRail external_ref.
  const media = await prisma.media.create({
    data: {
      ...(mData.ref ? { ref: mData.ref } : {}),
      channelId: channelDoc.id,
      name: mData.name,
      description: mData.description || "",
      blob,
      mediaType: mData.media_type || "video",
      thumbnailUrl: mData.thumbnail_url || "",
      previewImageUrls: mData.preview_image_urls || [],
      position: mData.position ?? (maxPos?.position ?? 0) + 1,
    },
  });

  if (mData.product && sk && channelDoc.satsrailProductTypeId) {
    try {
      await createEncryptedMediaProduct(sk, {
        name: mData.product.name, price_cents: mData.product.price_cents,
        currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
        product_type_id: channelDoc.satsrailProductTypeId,
        external_ref: mData.product.external_ref || `md_${media.ref}`,
      }, media.id, productPlaintext, api, onStatus);
    } catch (err) {
      errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
    }
  }

  await prisma.channel.update({
    where: { id: channelDoc.id },
    data: { mediaCount: { increment: 1 } },
  });
}

// ─── Channel-scoped product (bundle) ───────────────────────────────

/**
 * Create or refresh the channel-scoped Product for a channel, plus one
 * MediaEncryptedBlob row per media in the channel.
 */
export async function createEncryptedChannelProduct(
  sk: string,
  productData: {
    name: string;
    price_cents: number;
    currency?: string;
    access_duration_seconds?: number;
    product_type_id: string;
    external_ref: string;
  },
  channelId: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const existing = await prisma.product.findFirst({ where: { channelId } });

  if (existing) {
    await onStatus?.("Updating channel product on SatsRail...");
    await api.throttle();
    await withRetry(() =>
      satsrail.updateProduct(sk, existing.satsrailProductId, {
        name: productData.name,
        price_cents: productData.price_cents,
        access_duration_seconds: productData.access_duration_seconds,
      })
    );

    await onStatus?.("Fetching encryption key...");
    const keyResult = await getProductKeySafe(sk, existing.satsrailProductId, productData, api, onStatus);
    const mediaItems = await prisma.media.findMany({
      where: { channelId },
      select: { id: true, blob: true },
    });

    await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);

    // Transactionally replace this product's blob set: clear old, insert fresh.
    await prisma.$transaction([
      prisma.mediaEncryptedBlob.deleteMany({ where: { productId: existing.id } }),
      ...mediaItems.map((m) =>
        prisma.mediaEncryptedBlob.create({
          data: {
            productId: existing.id,
            mediaId: m.id,
            encryptedSource: encryptSourceUrl(
              productPlaintextFromMediaRow(m),
              keyResult.key,
              keyResult.productId
            ),
            keyFingerprint: keyResult.key_fingerprint,
          },
        })
      ),
      prisma.product.update({
        where: { id: existing.id },
        data: {
          keyFingerprint: keyResult.key_fingerprint,
          productName: productData.name,
          productPriceCents: productData.price_cents,
          productCurrency: productData.currency,
          productAccessDurationSeconds: productData.access_duration_seconds,
          productExternalRef: productData.external_ref,
          productStatus: "active",
          syncedAt: new Date(),
        },
      }),
    ]);
    return;
  }

  await onStatus?.("Creating channel access product on SatsRail...");
  const satsrailProduct = await createProductSafe(sk, productData, api, onStatus);
  const keyResult = await getProductKeySafe(sk, satsrailProduct.id, productData, api, onStatus);

  const mediaItems = await prisma.media.findMany({
    where: { channelId },
    select: { id: true, blob: true },
  });

  await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);

  await prisma.product.create({
    data: {
      channelId,
      satsrailProductId: keyResult.productId,
      keyFingerprint: keyResult.key_fingerprint,
      productName: productData.name,
      productPriceCents: productData.price_cents,
      productCurrency: productData.currency,
      productAccessDurationSeconds: productData.access_duration_seconds,
      productExternalRef: productData.external_ref,
      productStatus: "active",
      syncedAt: new Date(),
      mediaEncryptedBlobs: {
        create: mediaItems.map((m) => ({
          mediaId: m.id,
          encryptedSource: encryptSourceUrl(
            productPlaintextFromMediaRow(m),
            keyResult.key,
            keyResult.productId
          ),
          keyFingerprint: keyResult.key_fingerprint,
        })),
      },
    },
  });
}

// ─── Re-exports ─────────────────────────────────────────────────────

// Re-export blob helpers so other modules can pull them from one place.
export { mediaBlobSchema, parseMediaBlob, plaintextForEncryption };
export type { MediaBlob };
