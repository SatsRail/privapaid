import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMediaImages } from "@/lib/images";
import { requireAdminApi } from "@/lib/auth-helpers";
import { decryptEnvelopePayload } from "@/lib/media-envelope";

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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const channel = await prisma.channel.findFirst({
    where: { id, deletedAt: null },
  });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const media = await prisma.media.findMany({
    where: { channelId: id, deletedAt: null },
    orderBy: { position: "asc" },
    include: {
      images: {
        select: { id: true, kind: true, externalUrl: true, position: true },
      },
      envelope: { select: { id: true, bytes: true, wrappedDek: true } },
    },
  });

  const mediaIds = media.map((m) => m.id);
  const mediaProducts = mediaIds.length > 0
    ? await prisma.product.findMany({ where: { mediaId: { in: mediaIds } } })
    : [];
  const productByMediaId = new Map(
    mediaProducts
      .filter((mp): mp is typeof mp & { mediaId: string } => mp.mediaId !== null)
      .map((mp) => [mp.mediaId, mp])
  );

  const exportMedia = await Promise.all(media.map(async (m) => {
    const mp = productByMediaId.get(m.id);
    const item: Record<string, unknown> = {
      ref: m.ref,
      name: m.name,
      description: m.description || "",
      source_url: await sourceUrlForExport(m),
      media_type: m.mediaType,
      thumbnail_url: resolveMediaImages(m.images).thumbnailUrl,
      position: m.position,
    };

    if (mp) {
      item.product = {
        name: mp.productName || m.name,
        price_cents: mp.productPriceCents || 0,
        ...(mp.productCurrency ? { currency: mp.productCurrency } : {}),
        ...(mp.productAccessDurationSeconds
          ? { access_duration_seconds: mp.productAccessDurationSeconds }
          : {}),
      };
    }

    return item;
  }));

  const payload = {
    version: "1.0" as const,
    media: exportMedia,
  };

  const filename = `channel-${channel.slug}-export.json`;

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
