import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMediaImages } from "@/lib/images";
import { requireAdminApi } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { decryptEnvelopePayload } from "@/lib/media-envelope";

/**
 * Recover the on-the-wire `source_url` field for export by decrypting the
 * media's envelope (admin-only). url media → the source URL; article → the
 * markdown body (so the export round-trips). Photos surface the envelope id
 * pointer — their bytes aren't a re-importable source_url (re-upload via
 * /api/admin/photos and match ids on re-import).
 */
async function sourceUrlForExport(media: {
  mediaType: string;
  envelope: { id: string; bytes: Uint8Array; wrappedDek: string | null } | null;
}): Promise<string> {
  if (!media.envelope) return "";
  if (media.mediaType === "photo") return media.envelope.id;
  try {
    return decryptEnvelopePayload(media.envelope).toString("utf8");
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
        include: {
          images: {
            select: { id: true, kind: true, externalUrl: true, position: true },
          },
          envelope: { select: { id: true, bytes: true, wrappedDek: true } },
        },
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
    channels: await Promise.all(channels.map(async (ch) => {
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
        media: await Promise.all(channelMedia.map(async (m) => {
          const mp = mediaProductMap.get(m.id);
          const { thumbnailUrl, previewUrls } = resolveMediaImages(m.images);

          return {
            ref: m.ref,
            name: m.name,
            description: m.description || "",
            source_url: await sourceUrlForExport(m),
            media_type: m.mediaType,
            thumbnail_url: thumbnailUrl,
            preview_image_urls: previewUrls,
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
        })),
      };
    })),
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
