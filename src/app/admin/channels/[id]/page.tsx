import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Badge from "@/components/ui/Badge";
import { t } from "@/i18n";
import { getInstanceConfig } from "@/config/instance";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import ChannelProductSection from "./ChannelProductSection";
import ChannelImportSection from "./ChannelImportSection";
import ChannelSamplerPreview from "./ChannelSamplerPreview";
import DeleteChannelButton from "./DeleteChannelButton";
import { buttonClasses } from "@/components/ui/buttonStyles";

export const dynamic = "force-dynamic";

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { locale, currency } = await getInstanceConfig();

  const channel = await prisma.channel.findUnique({
    where: { id },
    include: { category: { select: { name: true } } },
  });
  if (!channel) notFound();

  const media = await prisma.media.findMany({
    where: { channelId: id },
    orderBy: { position: "asc" },
  });

  const cat = channel.category;

  // Media-scoped (direct-sale) products for these media.
  const mediaIds = media.map((m) => m.id);
  const directProducts = await prisma.product.findMany({
    where: { mediaId: { in: mediaIds } },
    select: { mediaId: true },
  });
  const mediaWithProduct = new Set(
    directProducts.map((p) => p.mediaId).filter((id): id is string => id !== null)
  );

  // Channel-scoped products and their per-media blob coverage.
  const channelProductDocs = await prisma.product.findMany({
    where: { channelId: id },
    select: {
      satsrailProductId: true,
      mediaEncryptedBlobs: { select: { mediaId: true } },
    },
  });

  const mediaCoveredByChannel = new Set<string>();
  for (const cp of channelProductDocs) {
    for (const em of cp.mediaEncryptedBlobs) {
      mediaCoveredByChannel.add(em.mediaId);
    }
  }

  // Fetch channel product details from SatsRail for display
  interface ChannelProductData {
    satsrail_product_id: string;
    name: string;
    price_cents: number;
    currency: string;
    status: string;
    encrypted_media_count: number;
  }

  let channelProducts: ChannelProductData[] = [];
  if (channelProductDocs.length > 0) {
    const sk = await getMerchantKey();
    if (sk && channel.ref != null) {
      try {
        const res = await satsrail.listProducts(sk, {
          external_ref_eq: `ch_${channel.ref}`,
        });
        const satsrailProductMap = new Map(
          res.data.map((p) => [p.id, p])
        );

        channelProducts = channelProductDocs
          .map((doc) => {
            const sp = satsrailProductMap.get(doc.satsrailProductId);
            if (!sp) return null;
            return {
              satsrail_product_id: doc.satsrailProductId,
              name: sp.name,
              price_cents: sp.price_cents,
              currency: sp.currency,
              status: sp.status,
              encrypted_media_count: doc.mediaEncryptedBlobs.length,
            };
          })
          .filter((p): p is ChannelProductData => p !== null);
      } catch {
        // SatsRail unreachable — show local data only
      }
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{channel.name}</h1>
            {channel.ref != null && (
              <span className="rounded bg-[var(--theme-bg-secondary)] border border-[var(--theme-border)] px-2 py-0.5 font-mono text-xs text-[var(--theme-text-secondary)]">
                ch_{channel.ref}
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--theme-text-secondary)]">
            /{channel.slug} · {cat?.name || t(locale, "admin.channels.no_category")} ·{" "}
            <Badge color={channel.active ? "green" : "red"}>
              {channel.active ? t(locale, "admin.channels.active") : t(locale, "admin.channels.inactive")}
            </Badge>
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/admin/channels/${id}/edit`}
            className={buttonClasses()}
          >
            {t(locale, "admin.channels.edit")}
          </Link>
          <DeleteChannelButton
            channelId={id}
            name={channel.name}
            mediaCount={media.length}
          />
        </div>
      </div>

      {/* Channel Products Section */}
      <ChannelProductSection
        channelId={id}
        products={channelProducts}
        currency={currency || "USD"}
        mediaCount={media.length}
      />

      {/* Channel Import/Export */}
      <ChannelImportSection channelId={id} />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t(locale, "admin.channels.media")} ({media.length})</h2>
        <Link
          href={`/admin/channels/${id}/media/new`}
          className="rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm hover:opacity-80"
        >
          {t(locale, "admin.channels.add_media")}
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--theme-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--theme-bg-secondary)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">#</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]" aria-label="Thumbnail" />
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">Ref</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">{t(locale, "admin.channels.name")}</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">{t(locale, "admin.channels.type")}</th>
              <th className="px-4 py-3 text-left font-medium text-[var(--theme-text-secondary)]">Product</th>
              <th className="px-4 py-3 text-right font-medium text-[var(--theme-text-secondary)]">{t(locale, "admin.channels.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--theme-border)]">
            {media.map((m) => {
              const hasIndividual = mediaWithProduct.has(m.id);
              const hasChannel = mediaCoveredByChannel.has(m.id);

              return (
                <tr key={m.id} className="hover:bg-[var(--theme-bg-secondary)]">
                  <td className="px-4 py-3 text-[var(--theme-text-secondary)]">{m.position}</td>
                  <td className="px-4 py-3">
                    {m.thumbnailBytes || m.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={
                          m.thumbnailBytes
                            ? `/api/images/media-thumbnail/${m.id}`
                            : m.thumbnailUrl
                        }
                        alt=""
                        className="h-10 w-16 rounded object-cover"
                      />
                    ) : (
                      <div className="h-10 w-16 rounded bg-[var(--theme-bg-secondary)]" />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--theme-text-secondary)]">
                    {m.ref != null ? `md_${m.ref}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{m.name}</span>
                      {m.status === "error" && (
                        <span title={m.statusReason ?? undefined}>
                          <Badge color="red">{t(locale, "admin.media.status_error_badge")}</Badge>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge>{m.mediaType}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {hasChannel && (
                        <Badge color="green">Channel</Badge>
                      )}
                      {hasIndividual && (
                        <Badge color="blue">Individual</Badge>
                      )}
                      {!hasChannel && !hasIndividual && (
                        <span className="text-[var(--theme-text-secondary)]">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/channels/${id}/media/${m.id}/edit`}
                      className="text-[var(--theme-primary)] hover:underline"
                    >
                      {t(locale, "admin.channels.edit")}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {media.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-4 text-center text-[var(--theme-text-secondary)]">
                  {t(locale, "admin.channels.media_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {media.length === 0 && <ChannelSamplerPreview channelId={id} />}
    </div>
  );
}
