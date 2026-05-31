import { prisma } from "@/lib/prisma";
import { createEnvelopeArtifacts, URL_ENVELOPE_MIME } from "@/lib/media-envelope";

export async function createCategory(overrides: Partial<{
  name: string;
  slug: string;
  position: number;
  active: boolean;
}> = {}) {
  return prisma.category.create({
    data: {
      name: "Test Category",
      slug: `test-category-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      position: 0,
      active: true,
      ...overrides,
    },
  });
}

export async function createChannel(overrides: Partial<{
  name: string;
  slug: string;
  bio: string;
  active: boolean;
  ref: number;
  categoryId: string | null;
  satsrailProductTypeId: string | null;
  nsfw: boolean;
  profileImageUrl: string;
  socialLinks: Record<string, string>;
  mediaCount: number;
  deletedAt: Date | null;
}> = {}) {
  return prisma.channel.create({
    data: {
      name: "Test Channel",
      slug: `test-channel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bio: "A test channel",
      active: true,
      ...overrides,
    },
  });
}

export async function createMedia(
  channelId: string,
  overrides: Partial<{
    name: string;
    sourceUrl: string;
    mediaType: "video" | "audio" | "article" | "photo" | "podcast";
    ref: number;
    description: string;
    position: number;
    blob: unknown;
  }> = {}
) {
  const { sourceUrl, blob, mediaType, ...rest } = overrides;
  const finalType = mediaType ?? "video";
  // Media.blob no longer exists; every media has one MediaEnvelope holding its
  // encrypted payload. Accept a legacy `{ url }` blob for caller convenience.
  const payload =
    sourceUrl ??
    (blob && typeof blob === "object" && blob !== null && "url" in blob
      ? (blob as { url?: string }).url
      : undefined) ??
    "https://example.com/video.mp4";
  const mimeType =
    finalType === "article"
      ? "text/markdown; charset=utf-8"
      : finalType === "photo"
        ? "image/jpeg"
        : URL_ENVELOPE_MIME;
  const art = createEnvelopeArtifacts(Buffer.from(payload, "utf8"));
  return prisma.media.create({
    data: {
      channelId,
      name: "Test Media",
      mediaType: finalType,
      envelope: {
        create: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          bytes: art.bytes as any,
          mimeType,
          wrappedDek: art.wrappedDek,
        },
      },
      ...rest,
    },
  });
}

export async function createMediaImage(
  mediaId: string,
  overrides: Partial<{
    kind: "thumbnail" | "preview";
    externalUrl: string;
    position: number;
  }> = {}
) {
  return prisma.mediaImage.create({
    data: {
      mediaId,
      kind: overrides.kind ?? "preview",
      externalUrl: overrides.externalUrl ?? "https://example.com/image.jpg",
      position: overrides.position ?? 0,
    },
  });
}

export async function createSettings(
  overrides: Partial<{
    instanceName: string;
    setupCompleted: boolean;
    merchantId: string | null;
    satsrailApiUrl: string;
    satsrailApiKeyEncrypted: string | null;
  }> = {}
) {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: {
      instanceName: "Test Instance",
      setupCompleted: true,
      ...overrides,
    },
    create: {
      id: 1,
      instanceName: "Test Instance",
      setupCompleted: true,
      ...overrides,
    },
  });
}

export async function createWebhookEvent(
  overrides: Partial<{
    eventId: string;
    eventType: string;
  }> = {}
) {
  return prisma.webhookEvent.create({
    data: {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      eventType: "test.event",
      ...overrides,
    },
  });
}

// ── Query helpers ──────────────────────────────────────────────────

/**
 * Tests written against the legacy `MediaProduct` model expect a single row
 * carrying both the cached product fields (productName, satsrailProductId,
 * etc.) and the ciphertext (encryptedSource, keyFingerprint). This helper
 * joins `Product` + its `MediaProduct` and returns the combined shape
 * so those expectations keep reading naturally.
 */
type MediaProductRowView = {
  id: string;
  mediaId: string;
  satsrailProductId: string;
  encryptedSource: string;
  keyFingerprint: string | null;
  productName: string | null;
  productPriceCents: number | null;
  productCurrency: string | null;
  productAccessDurationSeconds: number | null;
  productStatus: string | null;
  productSlug: string | null;
  productExternalRef: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function flatten(
  product: {
    id: string;
    mediaId: string | null;
    satsrailProductId: string;
    productName: string | null;
    productPriceCents: number | null;
    productCurrency: string | null;
    productAccessDurationSeconds: number | null;
    productStatus: string | null;
    productSlug: string | null;
    productExternalRef: string | null;
    syncedAt: Date | null;
    keyFingerprint: string | null;
    createdAt: Date;
    updatedAt: Date;
    mediaProducts?: Array<{
      encryptedDek: string;
      keyFingerprint: string | null;
    }>;
  } | null
): MediaProductRowView | null {
  if (!product || !product.mediaId) return null;
  const blob = product.mediaProducts?.[0];
  return {
    id: product.id,
    mediaId: product.mediaId,
    satsrailProductId: product.satsrailProductId,
    encryptedSource: blob?.encryptedDek ?? "",
    keyFingerprint: blob?.keyFingerprint ?? product.keyFingerprint,
    productName: product.productName,
    productPriceCents: product.productPriceCents,
    productCurrency: product.productCurrency,
    productAccessDurationSeconds: product.productAccessDurationSeconds,
    productStatus: product.productStatus,
    productSlug: product.productSlug,
    productExternalRef: product.productExternalRef,
    syncedAt: product.syncedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** findMany on the legacy MediaProduct shape. */
export async function findMediaProducts(where: { mediaId?: string; satsrailProductId?: string } = {}): Promise<MediaProductRowView[]> {
  const products = await prisma.product.findMany({
    where: {
      ...where,
      mediaId: where.mediaId ?? { not: null },
    },
    include: { mediaProducts: true },
  });
  return products.map((p) => flatten(p)).filter((v): v is MediaProductRowView => v !== null);
}

/** findFirst on the legacy MediaProduct shape. */
export async function findFirstMediaProduct(where: { mediaId?: string; satsrailProductId?: string } = {}): Promise<MediaProductRowView | null> {
  const product = await prisma.product.findFirst({
    where: {
      ...where,
      mediaId: where.mediaId ?? { not: null },
    },
    include: { mediaProducts: true },
  });
  return flatten(product);
}

/** Count of media-scoped products (legacy MediaProduct.count semantics). */
export async function countMediaProducts(): Promise<number> {
  return prisma.product.count({ where: { mediaId: { not: null } } });
}

/** Count of channel-scoped products (legacy ChannelProduct.count semantics). */
export async function countChannelProducts(): Promise<number> {
  return prisma.product.count({ where: { channelId: { not: null } } });
}

// ── Product + MediaProduct test helpers ──────────────────────
//
// These wrap the new schema so tests can keep their legacy-shaped intent
// (`createMediaProduct(...)`, `createChannelProduct(...)`) without
// open-coding the Product+blob split each time.

interface CachedProductFields {
  keyFingerprint?: string | null;
  productName?: string | null;
  productPriceCents?: number | null;
  productCurrency?: string | null;
  productAccessDurationSeconds?: number | null;
  productStatus?: string | null;
  productSlug?: string | null;
  productExternalRef?: string | null;
  syncedAt?: Date | null;
}

/**
 * Create a media-scoped Product (mediaId set) + its single MediaProduct.
 * Matches the old `prisma.mediaProduct.create` call signature where the
 * cached fields lived alongside the encryptedSource on one row.
 */
export async function createMediaProduct(
  opts: {
    mediaId: string;
    satsrailProductId: string;
    encryptedSource: string;
  } & CachedProductFields
) {
  const {
    mediaId,
    satsrailProductId,
    encryptedSource,
    keyFingerprint,
    ...cached
  } = opts;

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        mediaId,
        satsrailProductId,
        keyFingerprint: keyFingerprint ?? null,
        ...cached,
      },
    });
    await tx.mediaProduct.create({
      data: {
        productId: product.id,
        mediaId,
        encryptedDek: encryptedSource,
        keyFingerprint: keyFingerprint ?? null,
      },
    });
    return product;
  });
}

/**
 * Create a channel-scoped Product (channelId set) + N MediaProduct rows.
 * Matches the old `prisma.channelProduct.create` call where `encryptedMedia.create`
 * was the nested writer.
 */
export async function createChannelProduct(
  opts: {
    channelId: string;
    satsrailProductId: string;
    encryptedMedia?: Array<{
      mediaId: string;
      encryptedSource: string;
      keyFingerprint?: string | null;
    }>;
  } & CachedProductFields
) {
  const {
    channelId,
    satsrailProductId,
    encryptedMedia = [],
    keyFingerprint,
    ...cached
  } = opts;

  return prisma.product.create({
    data: {
      channelId,
      satsrailProductId,
      keyFingerprint: keyFingerprint ?? null,
      ...cached,
      mediaProducts: {
        create: encryptedMedia.map((em) => ({
          mediaId: em.mediaId,
          encryptedDek: em.encryptedSource,
          keyFingerprint: em.keyFingerprint ?? keyFingerprint ?? null,
        })),
      },
    },
  });
}
