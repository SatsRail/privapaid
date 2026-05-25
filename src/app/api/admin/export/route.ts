import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { parseMediaBlob } from "@/lib/schemas/media-blob";

/**
 * Recover the on-the-wire `source_url` field from Media.blob for export.
 * For photos this is the EncryptedPhotoBlob.id pointer (matching the legacy
 * shape — admins can re-link by uploading bytes through /api/admin/photos
 * and matching ids in a re-import). For everything else it's the URL or
 * markdown body.
 */
function sourceUrlForExport(blob: unknown): string {
  try {
    const parsed = parseMediaBlob(blob);
    if (parsed.kind === "url") return parsed.url;
    if (parsed.kind === "markdown") return parsed.body;
    return parsed.blobId; // photo
  } catch {
    return "";
  }
}

export async function GET() {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  // Fetch all data
  const [categories, channels] = await Promise.all([
    prisma.category.findMany({ orderBy: { position: "asc" } }),
    prisma.channel.findMany({
      where: { deletedAt: null },
      include: { category: { select: { slug: true } } },
    }),
  ]);

  // Fetch all media grouped by channel
  const channelIds = channels.map((ch) => ch.id);
  const allMedia = channelIds.length > 0
    ? await prisma.media.findMany({
        where: { channelId: { in: channelIds }, deletedAt: null },
        orderBy: { position: "asc" },
      })
    : [];

  // Fetch all media-scoped (direct-sale) products from cached data
  const mediaIds = allMedia.map((m) => m.id);
  const mediaProducts = mediaIds.length > 0
    ? await prisma.product.findMany({ where: { mediaId: { in: mediaIds } } })
    : [];

  const mediaProductMap = new Map<string, (typeof mediaProducts)[0]>();
  for (const mp of mediaProducts) {
    if (mp.mediaId) mediaProductMap.set(mp.mediaId, mp);
  }

  // Fetch all channel-scoped products
  const channelProducts = channelIds.length > 0
    ? await prisma.product.findMany({
        where: { channelId: { in: channelIds } },
      })
    : [];

  const channelProductMap = new Map<string, (typeof channelProducts)[0]>();
  for (const cp of channelProducts) {
    if (cp.channelId) channelProductMap.set(cp.channelId, cp);
  }

  // Group media by channel
  const mediaByChannel = new Map<string, typeof allMedia>();
  for (const m of allMedia) {
    if (!mediaByChannel.has(m.channelId)) mediaByChannel.set(m.channelId, []);
    mediaByChannel.get(m.channelId)!.push(m);
  }

  // Assemble export JSON
  const exportData = {
    version: "1.0" as const,
    exported_at: new Date().toISOString(),
    categories: categories.map((cat) => ({
      slug: cat.slug,
      name: cat.name,
      position: cat.position,
      active: cat.active,
    })),
    channels: channels.map((ch) => {
      const channelMedia = mediaByChannel.get(ch.id) || [];
      const categorySlug = ch.category?.slug ?? null;

      // Channel product from cached data
      const cp = channelProductMap.get(ch.id);

      return {
        ref: ch.ref,
        slug: ch.slug,
        name: ch.name,
        bio: ch.bio || "",
        category_slug: categorySlug || null,
        nsfw: ch.nsfw,
        social_links: ch.socialLinks || {},
        profile_image_url: ch.profileImageUrl || "",
        active: ch.active,
        ...(cp?.productName
          ? {
              product: {
                name: cp.productName,
                price_cents: cp.productPriceCents ?? 0,
                currency: cp.productCurrency || "USD",
                access_duration_seconds: cp.productAccessDurationSeconds,
                external_ref: cp.productExternalRef || (ch.ref != null ? `ch_${ch.ref}` : undefined),
              },
            }
          : {}),
        media: channelMedia.map((m) => {
          const mp = mediaProductMap.get(m.id);

          return {
            ref: m.ref,
            name: m.name,
            description: m.description || "",
            source_url: sourceUrlForExport(m.blob),
            media_type: m.mediaType,
            thumbnail_url: m.thumbnailUrl || "",
            preview_image_urls: m.previewImageUrls || [],
            position: m.position,
            ...(mp?.productName
              ? {
                  product: {
                    name: mp.productName,
                    price_cents: mp.productPriceCents ?? 0,
                    currency: mp.productCurrency || "USD",
                    access_duration_seconds: mp.productAccessDurationSeconds,
                    external_ref: mp.productExternalRef || (m.ref != null ? `md_${m.ref}` : undefined),
                  },
                }
              : {}),
          };
        }),
      };
    }),
  };

  audit({
    actorId: auth.id,
    actorEmail: auth.email,
    actorType: "admin",
    action: "export.create",
    targetType: "content",
    details: {
      categories: exportData.categories.length,
      channels: exportData.channels.length,
      media: exportData.channels.reduce((sum, ch) => sum + ch.media.length, 0),
    },
  });

  const dateStr = new Date().toISOString().split("T")[0];
  return new NextResponse(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="privapaid-export-${dateStr}.json"`,
    },
  });
}
