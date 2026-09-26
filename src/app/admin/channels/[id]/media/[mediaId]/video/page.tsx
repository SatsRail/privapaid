import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { videoEnabled } from "@/lib/video/config";
import VideoUpload from "./VideoUpload";
export const dynamic = "force-dynamic";
export default async function VideoPage({ params }: { params: Promise<{ id: string; mediaId: string }> }) {
  await requireOwner(); if (!videoEnabled()) notFound();
  const { id, mediaId } = await params;
  const media = await prisma.media.findFirst({ where: { id: mediaId, channelId: id, mediaType: "video", deletedAt: null },
    include: { mediaProducts: { include: { product: true } } } });
  if (!media) notFound();
  const products = media.mediaProducts.filter(row => row.product.productStatus === "active")
    .map(row => ({ id: row.productId, name: row.product.productName || (row.product.mediaId ? "Video access" : "Channel access") }));
  return <div className="mx-auto max-w-2xl space-y-6">
    <Link href={`/admin/channels/${id}/media/${mediaId}/edit`} className="text-[var(--theme-link)]">Back to media</Link>
    <h1 className="text-2xl font-semibold">Prepare video · {media.name}</h1>
    <p className="text-[var(--theme-text-secondary)]">Experimental video preparation. Accepts H.264 MP4, optional AAC audio, up to 10 GiB, 4K/60 fps and four hours. Creates one rendition up to 720p.</p>
    <p className="rounded-xl border border-[var(--theme-border)] p-4">Customer playback for this format arrives in Phase 3. Your existing video remains available while you prepare this version.</p>
    <VideoUpload mediaId={mediaId} products={products} />
  </div>;
}
