import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getNextRef } from "@/models/Counter";
import { satsrail } from "@/lib/satsrail";
import { encryptSourceUrl } from "@/lib/content-encryption";
import { schemas } from "@/lib/validate";

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

// Create or update a MediaProduct with encryption
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
  sourceUrl: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const product = await createProductSafe(sk, productData, api, onStatus);
  const keyResult = await getProductKeySafe(sk, product.id, productData, api, onStatus);

  await onStatus?.("Encrypting content...");
  const encryptedSourceUrl = encryptSourceUrl(sourceUrl, keyResult.key, keyResult.productId);

  // Upsert: update existing MediaProduct or create new one
  const existingMp = await prisma.mediaProduct.findUnique({ where: { mediaId } });
  const mpData = {
    satsrailProductId: keyResult.productId,
    encryptedSourceUrl,
    keyFingerprint: keyResult.key_fingerprint,
    productName: productData.name,
    productPriceCents: productData.price_cents,
    productCurrency: productData.currency,
    productAccessDurationSeconds: productData.access_duration_seconds,
    productExternalRef: productData.external_ref,
    productStatus: "active",
    syncedAt: new Date(),
  };

  if (existingMp) {
    await onStatus?.("Updating encrypted product record...");
    await prisma.mediaProduct.update({ where: { id: existingMp.id }, data: mpData });
  } else {
    await onStatus?.("Saving encrypted product record...");
    await prisma.mediaProduct.create({ data: { mediaId, ...mpData } });
  }
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

// Update an existing media product's metadata and re-encrypt if source URL changed
export async function updateExistingProduct(
  sk: string,
  existingProduct: { id: string; satsrailProductId: string },
  mData: ImportMediaWithProduct,
  sourceUrlChanged: boolean,
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

  if (!sourceUrlChanged) {
    // Even when source URL didn't change, refresh cached external_ref so future
    // exports carry the canonical value rather than the formula fallback.
    await prisma.mediaProduct.update({
      where: { id: existingProduct.id },
      data: { productExternalRef: externalRef },
    });
    return;
  }

  const keyResult = await getProductKeySafe(sk, existingProduct.satsrailProductId, {
    name: mData.product.name, price_cents: mData.product.price_cents,
    currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
    product_type_id: channelDoc.satsrailProductTypeId || undefined, external_ref: externalRef,
  }, api, onStatus);

  await onStatus?.("Re-encrypting content...");
  const encryptedSourceUrl = encryptSourceUrl(mData.source_url, keyResult.key, keyResult.productId);
  await prisma.mediaProduct.update({
    where: { id: existingProduct.id },
    data: {
      satsrailProductId: keyResult.productId,
      encryptedSourceUrl,
      keyFingerprint: keyResult.key_fingerprint,
      productName: mData.product.name,
      productPriceCents: mData.product.price_cents,
      productCurrency: mData.product.currency,
      productAccessDurationSeconds: mData.product.access_duration_seconds,
      productExternalRef: externalRef,
      syncedAt: new Date(),
    },
  });
}

// Handle product for an existing media item (update or create)
export async function handleExistingMediaProduct(
  sk: string,
  mData: ImportMediaWithProduct,
  existingMedia: { id: string; ref: number },
  sourceUrlChanged: boolean,
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const existingProduct = await prisma.mediaProduct.findUnique({
    where: { mediaId: existingMedia.id },
  });
  const externalRef = mData.product.external_ref || `md_${existingMedia.ref}`;

  if (existingProduct) {
    try {
      await updateExistingProduct(sk, existingProduct, mData, sourceUrlChanged, channelDoc, externalRef, api, onStatus);
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
    }, existingMedia.id, mData.source_url, api, onStatus);
  } catch (err) {
    errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
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
  existingMedia: { id: string; ref: number; sourceUrl: string },
  channelDoc: { id: string; satsrailProductTypeId: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const sourceUrlChanged = Boolean(mData.source_url && mData.source_url !== existingMedia.sourceUrl);

  await onStatus?.("Updating media record...");
  await prisma.media.update({
    where: { id: existingMedia.id },
    data: {
      name: mData.name, description: mData.description || "",
      sourceUrl: mData.source_url, mediaType: mData.media_type || "video",
      thumbnailUrl: mData.thumbnail_url || "",
      ...(mData.preview_image_urls?.length ? { previewImageUrls: mData.preview_image_urls } : {}),
      ...(mData.position !== undefined ? { position: mData.position } : {}),
    },
  });

  if (mData.product && sk) {
    await handleExistingMediaProduct(sk, mData as ImportMediaWithProduct, existingMedia, sourceUrlChanged, channelDoc, errors, api, onStatus);
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
  // and writes ciphertext to the EncryptedPhotoBlob table). A URL-based
  // import has no way to produce the encrypted bytes or the DEK envelope, so
  // the imported row would be unviewable. Throwing here surfaces as an entry
  // in results.errors (route catches via try/catch).
  if (mData.media_type === "photo") {
    throw new Error(
      "Photo media cannot be imported from JSON — upload via /api/admin/photos to encrypt the bytes."
    );
  }

  const ref = await getNextRef("media");

  await onStatus?.("Saving media record...");
  const maxPos = await prisma.media.findFirst({
    where: { channelId: channelDoc.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const media = await prisma.media.create({
    data: {
      ref,
      channelId: channelDoc.id,
      name: mData.name,
      description: mData.description || "",
      sourceUrl: mData.source_url,
      mediaType: mData.media_type || "video",
      thumbnailUrl: mData.thumbnail_url || "",
      previewImageUrls: mData.preview_image_urls || [],
      position: mData.position ?? (maxPos?.position ?? 0) + 1,
      commentsCount: 0,
      flagsCount: 0,
    },
  });

  if (mData.product && sk && channelDoc.satsrailProductTypeId) {
    try {
      await createEncryptedMediaProduct(sk, {
        name: mData.product.name, price_cents: mData.product.price_cents,
        currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
        product_type_id: channelDoc.satsrailProductTypeId,
        external_ref: mData.product.external_ref || `md_${ref}`,
      }, media.id, mData.source_url, api, onStatus);
    } catch (err) {
      errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
    }
  }

  await prisma.channel.update({
    where: { id: channelDoc.id },
    data: { mediaCount: { increment: 1 } },
  });
}

// ─── Channel Product Helpers ──────────────────────────────────────

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
  // Check if ChannelProduct already exists for this channel
  const existing = await prisma.channelProduct.findFirst({ where: { channelId } });
  if (existing) {
    // Update SatsRail product metadata
    await onStatus?.("Updating channel product on SatsRail...");
    await api.throttle();
    await withRetry(() =>
      satsrail.updateProduct(sk, existing.satsrailProductId, {
        name: productData.name,
        price_cents: productData.price_cents,
        access_duration_seconds: productData.access_duration_seconds,
      })
    );

    // Re-encrypt all media with the existing key
    await onStatus?.("Fetching encryption key...");
    const keyResult = await getProductKeySafe(sk, existing.satsrailProductId, productData, api, onStatus);
    const mediaItems = await prisma.media.findMany({
      where: { channelId },
      select: { id: true, sourceUrl: true },
    });

    await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);

    // Transactionally replace the encrypted_media set: clear old, insert fresh.
    await prisma.$transaction([
      prisma.channelProductMedia.deleteMany({ where: { channelProductId: existing.id } }),
      ...mediaItems.map((m: { id: string; sourceUrl: string }) =>
        prisma.channelProductMedia.create({
          data: {
            channelProductId: existing.id,
            mediaId: m.id,
            encryptedSourceUrl: encryptSourceUrl(m.sourceUrl, keyResult.key, keyResult.productId),
            keyFingerprint: keyResult.key_fingerprint,
          },
        })
      ),
      prisma.channelProduct.update({
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

  // Create new channel access product
  await onStatus?.("Creating channel access product on SatsRail...");
  const product = await createProductSafe(sk, productData, api, onStatus);
  const keyResult = await getProductKeySafe(sk, product.id, productData, api, onStatus);

  const mediaItems = await prisma.media.findMany({
    where: { channelId },
    select: { id: true, sourceUrl: true },
  });

  await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);

  await prisma.channelProduct.create({
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
      encryptedMedia: {
        create: mediaItems.map((m: { id: string; sourceUrl: string }) => ({
          mediaId: m.id,
          encryptedSourceUrl: encryptSourceUrl(m.sourceUrl, keyResult.key, keyResult.productId),
          keyFingerprint: keyResult.key_fingerprint,
        })),
      },
    },
  });
}
