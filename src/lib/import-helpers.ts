import { z } from "zod";
import Channel from "@/models/Channel";
import Media from "@/models/Media";
import MediaProduct from "@/models/MediaProduct";
import ChannelProduct from "@/models/ChannelProduct";
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
  const existingMp = await MediaProduct.findOne({ media_id: mediaId });
  const mpData = {
    satsrail_product_id: keyResult.productId,
    encrypted_source_url: encryptedSourceUrl,
    key_fingerprint: keyResult.key_fingerprint,
    product_name: productData.name,
    product_price_cents: productData.price_cents,
    product_currency: productData.currency,
    product_access_duration_seconds: productData.access_duration_seconds,
    product_external_ref: productData.external_ref,
    product_status: "active",
    synced_at: new Date(),
  };

  if (existingMp) {
    await onStatus?.("Updating encrypted product record...");
    await MediaProduct.findByIdAndUpdate(existingMp._id, mpData);
  } else {
    await onStatus?.("Saving encrypted product record...");
    await MediaProduct.create({ media_id: mediaId, ...mpData });
  }
}

// ─── Channel Product Type Helpers ──────────────────────────────────

export async function ensureChannelProductType(
  sk: string,
  existingDoc: { _id: string; satsrail_product_type_id: string | null },
  chData: ImportChannel,
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const hasProducts = chData.media?.some((m: { product?: unknown }) => m.product);
  if (existingDoc.satsrail_product_type_id || !hasProducts) return;

  try {
    const ch = await Channel.findById(existingDoc._id).lean();
    const productType = await createProductSafeType(sk, chData.name, `ch_${ch?.ref || existingDoc._id}`, api, onStatus);
    existingDoc.satsrail_product_type_id = productType.id;
    await Channel.findByIdAndUpdate(existingDoc._id, { satsrail_product_type_id: productType.id });
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
  existingProduct: { _id: unknown; satsrail_product_id: string },
  mData: ImportMediaWithProduct,
  sourceUrlChanged: boolean,
  channelDoc: { satsrail_product_type_id: string | null },
  externalRef: string,
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  await onStatus?.("Updating product on SatsRail...");
  await api.throttle();
  await withRetry(() => satsrail.updateProduct(sk, existingProduct.satsrail_product_id, {
    name: mData.product.name,
    price_cents: mData.product.price_cents,
    access_duration_seconds: mData.product.access_duration_seconds,
  }));

  if (!sourceUrlChanged) {
    // Even when source URL didn't change, refresh cached external_ref so future
    // exports carry the canonical value rather than the formula fallback.
    await MediaProduct.findByIdAndUpdate(existingProduct._id, {
      product_external_ref: externalRef,
    });
    return;
  }

  const keyResult = await getProductKeySafe(sk, existingProduct.satsrail_product_id, {
    name: mData.product.name, price_cents: mData.product.price_cents,
    currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
    product_type_id: channelDoc.satsrail_product_type_id || undefined, external_ref: externalRef,
  }, api, onStatus);

  await onStatus?.("Re-encrypting content...");
  const encryptedSourceUrl = encryptSourceUrl(mData.source_url, keyResult.key, keyResult.productId);
  await MediaProduct.findByIdAndUpdate(existingProduct._id, {
    satsrail_product_id: keyResult.productId,
    encrypted_source_url: encryptedSourceUrl,
    key_fingerprint: keyResult.key_fingerprint,
    product_name: mData.product.name,
    product_price_cents: mData.product.price_cents,
    product_currency: mData.product.currency,
    product_access_duration_seconds: mData.product.access_duration_seconds,
    product_external_ref: externalRef,
    synced_at: new Date(),
  });
}

// Handle product for an existing media item (update or create)
export async function handleExistingMediaProduct(
  sk: string,
  mData: ImportMediaWithProduct,
  existingMedia: { _id: unknown; ref: number },
  sourceUrlChanged: boolean,
  channelDoc: { _id: string; satsrail_product_type_id: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const existingProduct = await MediaProduct.findOne({ media_id: String(existingMedia._id) });
  const externalRef = mData.product.external_ref || `md_${existingMedia.ref}`;

  if (existingProduct) {
    try {
      await updateExistingProduct(sk, existingProduct, mData, sourceUrlChanged, channelDoc, externalRef, api, onStatus);
    } catch (err) {
      errors.push({ entity: "media_product", name: mData.name, error: `Product update failed: ${errorMsg(err)}` });
    }
    return;
  }

  if (!channelDoc.satsrail_product_type_id) return;

  try {
    await createEncryptedMediaProduct(sk, {
      name: mData.product.name, price_cents: mData.product.price_cents,
      currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
      product_type_id: channelDoc.satsrail_product_type_id, external_ref: externalRef,
    }, String(existingMedia._id), mData.source_url, api, onStatus);
  } catch (err) {
    errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
  }
}

// Find existing media by ref or name
export async function findExistingMedia(mData: ImportMedia, channelId: string) {
  const byRef = mData.ref
    ? await Media.findOne({ ref: mData.ref, channel_id: channelId, deleted_at: null })
    : null;
  if (byRef) return byRef;

  return Media.findOne({ channel_id: channelId, name: mData.name, deleted_at: null });
}

export async function updateExistingMedia(
  sk: string | null,
  mData: ImportMedia,
  existingMedia: { _id: unknown; ref: number; source_url: string },
  channelDoc: { _id: string; satsrail_product_type_id: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  const sourceUrlChanged = Boolean(mData.source_url && mData.source_url !== existingMedia.source_url);

  await onStatus?.("Updating media record...");
  await Media.findByIdAndUpdate(existingMedia._id, {
    name: mData.name, description: mData.description || "",
    source_url: mData.source_url, media_type: mData.media_type || "video",
    thumbnail_url: mData.thumbnail_url || "",
    ...(mData.preview_image_urls?.length ? { preview_image_urls: mData.preview_image_urls } : {}),
    ...(mData.position !== undefined ? { position: mData.position } : {}),
  });

  if (mData.product && sk) {
    await handleExistingMediaProduct(sk, mData as ImportMediaWithProduct, existingMedia, sourceUrlChanged, channelDoc, errors, api, onStatus);
  }
}

export async function createNewMedia(
  sk: string | null,
  mData: ImportMedia,
  channelDoc: { _id: string; satsrail_product_type_id: string | null },
  errors: ImportError[],
  api: ApiThrottle,
  onStatus?: StatusFn
): Promise<void> {
  // Photo media is unsupported in JSON import flow: photos require uploading
  // raw bytes through /api/admin/photos (which generates the per-photo DEK
  // and writes ciphertext to GridFS). A URL-based import has no way to
  // produce the encrypted GridFS file or the DEK envelope, so the imported
  // row would be unviewable. Throwing here surfaces as an entry in
  // results.errors (route catches via try/catch).
  if (mData.media_type === "photo") {
    throw new Error(
      "Photo media cannot be imported from JSON — upload via /api/admin/photos to encrypt the bytes."
    );
  }

  const ref = await getNextRef("media");

  await onStatus?.("Saving media record...");
  const maxPos = await Media.findOne({ channel_id: channelDoc._id })
    .sort({ position: -1 })
    .select("position")
    .lean();

  const media = await Media.create({
    ref, channel_id: channelDoc._id, name: mData.name,
    description: mData.description || "", source_url: mData.source_url,
    media_type: mData.media_type || "video", thumbnail_url: mData.thumbnail_url || "",
    preview_image_urls: mData.preview_image_urls || [],
    position: mData.position ?? (maxPos?.position ?? 0) + 1,
    comments_count: 0, flags_count: 0,
  });

  if (mData.product && sk && channelDoc.satsrail_product_type_id) {
    try {
      await createEncryptedMediaProduct(sk, {
        name: mData.product.name, price_cents: mData.product.price_cents,
        currency: mData.product.currency, access_duration_seconds: mData.product.access_duration_seconds,
        product_type_id: channelDoc.satsrail_product_type_id,
        external_ref: mData.product.external_ref || `md_${ref}`,
      }, String(media._id), mData.source_url, api, onStatus);
    } catch (err) {
      errors.push({ entity: "media_product", name: mData.name, error: `Product creation failed: ${errorMsg(err)}` });
    }
  }

  await Channel.findByIdAndUpdate(channelDoc._id, { $inc: { media_count: 1 } });
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
  const existing = await ChannelProduct.findOne({ channel_id: channelId });
  if (existing) {
    // Update SatsRail product metadata
    await onStatus?.("Updating channel product on SatsRail...");
    await api.throttle();
    await withRetry(() =>
      satsrail.updateProduct(sk, existing.satsrail_product_id, {
        name: productData.name,
        price_cents: productData.price_cents,
        access_duration_seconds: productData.access_duration_seconds,
      })
    );

    // Re-encrypt all media with the existing key
    await onStatus?.("Fetching encryption key...");
    const keyResult = await getProductKeySafe(sk, existing.satsrail_product_id, productData, api, onStatus);
    const mediaItems = await Media.find({ channel_id: channelId }).select("_id source_url").lean();

    await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);
    const encrypted_media = mediaItems.map((m) => ({
      media_id: m._id,
      encrypted_source_url: encryptSourceUrl(m.source_url, keyResult.key, keyResult.productId),
    }));

    await ChannelProduct.findByIdAndUpdate(existing._id, {
      encrypted_media,
      key_fingerprint: keyResult.key_fingerprint,
      product_name: productData.name,
      product_price_cents: productData.price_cents,
      product_currency: productData.currency,
      product_access_duration_seconds: productData.access_duration_seconds,
      product_external_ref: productData.external_ref,
      product_status: "active",
      synced_at: new Date(),
    });
    return;
  }

  // Create new channel access product
  await onStatus?.("Creating channel access product on SatsRail...");
  const product = await createProductSafe(sk, productData, api, onStatus);
  const keyResult = await getProductKeySafe(sk, product.id, productData, api, onStatus);

  const mediaItems = await Media.find({ channel_id: channelId }).select("_id source_url").lean();

  await onStatus?.(`Encrypting ${mediaItems.length} media URLs...`);
  const encrypted_media = mediaItems.map((m) => ({
    media_id: m._id,
    encrypted_source_url: encryptSourceUrl(m.source_url, keyResult.key, keyResult.productId),
  }));

  await ChannelProduct.create({
    channel_id: channelId,
    satsrail_product_id: keyResult.productId,
    key_fingerprint: keyResult.key_fingerprint,
    encrypted_media,
    product_name: productData.name,
    product_price_cents: productData.price_cents,
    product_currency: productData.currency,
    product_access_duration_seconds: productData.access_duration_seconds,
    product_external_ref: productData.external_ref,
    product_status: "active",
    synced_at: new Date(),
  });
}
