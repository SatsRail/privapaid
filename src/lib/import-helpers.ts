import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { schemas } from "@/lib/validate";
import {
  createEnvelopeArtifacts,
  reencryptEnvelopeBytes,
  dekBase64urlFromEnvelope,
  URL_ENVELOPE_MIME,
} from "@/lib/media-envelope";

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

// ─── Envelope construction for import payloads ─────────────────────

/**
 * Result of building the envelope artifacts for an import entry.
 *   create — non-null when a fresh envelope must be written (the caller writes
 *            it with the owning mediaId once the Media row exists); null when an
 *            existing envelope was re-encrypted in place under its stable DEK.
 *   dekBase64url — the per-product plaintext (the media DEK) wrapped under each
 *            product key. Stable across updates, so per-product MediaProduct
 *            rows never need re-encryption when only the source changes.
 */
export interface ImportEnvelopeArtifacts {
  create: { bytes: Buffer; mimeType: string; wrappedDek: string } | null;
  dekBase64url: string;
}

/**
 * Build the MediaEnvelope artifacts + per-product DEK for an import entry.
 *
 * url media (video/audio/podcast) and article both encrypt their source_url
 * (URL or markdown body) into the one envelope. On update the existing envelope
 * is re-encrypted in place under its existing DEK; on create the caller writes a
 * fresh envelope linked to the new Media. Photos can't be imported via JSON.
 */
export async function buildArtifactsForImport(
  mData: ImportMedia,
  existingMedia: { id: string } | null
): Promise<ImportEnvelopeArtifacts> {
  const payload = Buffer.from(mData.source_url, "utf8");
  const mimeType = mData.media_type === "article" ? ARTICLE_MIME : URL_ENVELOPE_MIME;

  if (existingMedia) {
    const envelope = await prisma.mediaEnvelope.findUnique({
      where: { mediaId: existingMedia.id },
      select: { id: true, wrappedDek: true },
    });
    if (envelope) {
      // Re-encrypt under the existing DEK: the DEK — and every MediaProduct row
      // that wraps it — stays valid; only the ciphertext bytes change.
      const bytes = reencryptEnvelopeBytes(envelope, payload);
      await prisma.mediaEnvelope.update({
        where: { id: envelope.id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { bytes: bytes as any, mimeType },
      });
      return { create: null, dekBase64url: dekBase64urlFromEnvelope(envelope) };
    }
  }

  const artifacts = createEnvelopeArtifacts(payload);
  return {
    create: { bytes: artifacts.bytes, mimeType, wrappedDek: artifacts.wrappedDek },
    dekBase64url: artifacts.dekBase64url,
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
 * Create or update a media-scoped Product + its single MediaProduct row.
 * `productPlaintext` is the media DEK (base64url) wrapped under the product key
 * — uniform across all media kinds now.
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
  const encryptedDek = encryptSourceUrl(productPlaintext, keyResult.key, keyResult.productId);

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

    await tx.mediaProduct.upsert({
      where: { productId_mediaId: { productId: product.id, mediaId } },
      create: {
        productId: product.id,
        mediaId,
        encryptedDek,
        keyFingerprint: keyResult.key_fingerprint,
      },
      update: {
        encryptedDek,
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
 * the single MediaProduct row when the product plaintext has changed.
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
  const encryptedDek = encryptSourceUrl(newProductPlaintext, keyResult.key, keyResult.productId);

  await prisma.$transaction([
    prisma.product.update({
      where: { id: existingProduct.id },
      data: {
        satsrailProductId: keyResult.productId,
        keyFingerprint: keyResult.key_fingerprint,
        ...cachedFields,
      },
    }),
    prisma.mediaProduct.updateMany({
      where: { productId: existingProduct.id },
      data: {
        encryptedDek,
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
 * Read what gets wrapped under each product key for a Media row: the media DEK,
 * recovered from the envelope's wrappedDek. Uniform across all media kinds.
 */
function productDekFromMedia(media: {
  envelope: { wrappedDek: string | null } | null;
}): string {
  if (!media.envelope) {
    throw new Error("Media has no envelope; cannot derive product DEK");
  }
  return dekBase64urlFromEnvelope(media.envelope);
}

/**
 * Replace a media's url-backed MediaImage rows from the import wire fields.
 * Imports carry external image links (thumbnail_url + preview_image_urls), so
 * each becomes an externalUrl-backed row. Empty strings mean "no image" and
 * are skipped rather than stored as a blank URL.
 *
 * The thumbnail is always reconciled (the old import set Media.thumbnailUrl
 * unconditionally). Previews are only touched when the import provides them,
 * matching the old conditional write that left existing previews intact when
 * the field was absent.
 */
async function syncImportedMediaImages(
  mediaId: string,
  thumbnailUrl: string | undefined,
  previewUrls: string[] | undefined
): Promise<void> {
  await prisma.mediaImage.deleteMany({ where: { mediaId, kind: "thumbnail" } });
  if (thumbnailUrl) {
    await prisma.mediaImage.create({
      data: { mediaId, kind: "thumbnail", externalUrl: thumbnailUrl, position: 0 },
    });
  }

  if (previewUrls && previewUrls.length > 0) {
    await prisma.mediaImage.deleteMany({ where: { mediaId, kind: "preview" } });
    const rows = previewUrls
      .map((url, i) => ({ mediaId, kind: "preview" as const, externalUrl: url, position: i }))
      .filter((row) => !!row.externalUrl);
    if (rows.length > 0) {
      await prisma.mediaImage.createMany({ data: rows });
    }
  }
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
  existingMedia: { id: string; ref: number },
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const { create, dekBase64url } = await buildArtifactsForImport(mData, existingMedia);

  await onStatus?.("Updating media record...");
  await prisma.media.update({
    where: { id: existingMedia.id },
    data: {
      name: mData.name,
      description: mData.description || "",
      mediaType: mData.media_type || "video",
      ...(mData.position !== undefined ? { position: mData.position } : {}),
    },
  });
  // Edge case: a legacy media with no envelope yet — mint one now so it always
  // has exactly one envelope going forward.
  if (create) {
    await prisma.mediaEnvelope.create({
      data: {
        mediaId: existingMedia.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: create.bytes as any,
        mimeType: create.mimeType,
        wrappedDek: create.wrappedDek,
      },
    });
  }
  await syncImportedMediaImages(
    existingMedia.id,
    mData.thumbnail_url,
    mData.preview_image_urls
  );

  if (mData.product && sk) {
    // The per-product MediaProduct row wraps the media DEK, which is stable
    // across source edits (we re-encrypt only the envelope bytes). So per-product
    // rows need re-encryption only when a brand-new DEK was minted (the legacy
    // no-envelope edge case above).
    const productDekChanged = create !== null;
    await handleExistingMediaProduct(
      sk,
      mData as ImportMediaWithProduct,
      existingMedia,
      dekBase64url,
      productDekChanged,
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

  const { create, dekBase64url } = await buildArtifactsForImport(mData, null);

  // If the import payload specifies a `ref`, honor it (preserves the source
  // identity on replay/restore). Otherwise Postgres's autoincrement assigns
  // one. Either way we read `media.ref` back for the SatsRail external_ref.
  const media = await prisma.media.create({
    data: {
      ...(mData.ref ? { ref: mData.ref } : {}),
      channelId: channelDoc.id,
      name: mData.name,
      description: mData.description || "",
      mediaType: mData.media_type || "video",
      position: mData.position ?? (maxPos?.position ?? 0) + 1,
    },
  });
  // A fresh import always mints a new envelope (existingMedia is null).
  if (create) {
    await prisma.mediaEnvelope.create({
      data: {
        mediaId: media.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: create.bytes as any,
        mimeType: create.mimeType,
        wrappedDek: create.wrappedDek,
      },
    });
  }
  await syncImportedMediaImages(media.id, mData.thumbnail_url, mData.preview_image_urls);

  if (mData.product && sk && channelDoc.satsrailProductTypeId) {
    try {
      await createEncryptedMediaProduct(sk, {
        name: mData.product.name, price_cents: mData.product.price_cents,
        currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
        product_type_id: channelDoc.satsrailProductTypeId,
        external_ref: mData.product.external_ref || `md_${media.ref}`,
      }, media.id, dekBase64url, api, onStatus);
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
 * MediaProduct row per media in the channel.
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
      select: { id: true, envelope: { select: { wrappedDek: true } } },
    });

    await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);

    // Transactionally replace this product's blob set: clear old, insert fresh.
    await prisma.$transaction([
      prisma.mediaProduct.deleteMany({ where: { productId: existing.id } }),
      ...mediaItems.map((m) =>
        prisma.mediaProduct.create({
          data: {
            productId: existing.id,
            mediaId: m.id,
            encryptedDek: encryptSourceUrl(
              productDekFromMedia(m),
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
    select: { id: true, envelope: { select: { wrappedDek: true } } },
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
      mediaProducts: {
        create: mediaItems.map((m) => ({
          mediaId: m.id,
          encryptedDek: encryptSourceUrl(
            productDekFromMedia(m),
            keyResult.key,
            keyResult.productId
          ),
          keyFingerprint: keyResult.key_fingerprint,
        })),
      },
    },
  });
}

