import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getMerchantKey } from "@/lib/merchant-key";
import { satsrail } from "@/lib/satsrail";
import { unwrapDek } from "@/lib/content-dek";
import { decryptSourceUrl } from "@/lib/content-encryption";
import { sha256 } from "./format";
import { IngestionError } from "./ingestion-errors";
export type Binding = { productId: string; productFingerprint: string; bindingFingerprint: string; envelopeId: string; envelopeKeyFingerprint: string };
async function localBinding(tx: Prisma.TransactionClient, mediaId: string, productId: string) {
  const row = await tx.mediaProduct.findFirst({ where: { mediaId, productId }, include: { product: true, media: { include: { envelope: true, channel: true } } } });
  if (!row || row.media.deletedAt || row.media.mediaType !== "video" || row.media.status !== "ok" || row.media.channel.deletedAt || !row.media.channel.active ||
      !row.media.envelope?.wrappedDek || row.product.productStatus !== "active" ||
      !(row.product.mediaId === mediaId || row.product.channelId === row.media.channelId)) throw new IngestionError("PRODUCT_REQUIRED");
  return row;
}
export async function verifyProductBinding(mediaId: string, productId: string): Promise<Binding> {
  const row = await localBinding(prisma, mediaId, productId);
  const sk = await getMerchantKey(); if (!sk) throw new IngestionError("PRODUCT_REQUIRED");
  try {
    const remote = await satsrail.getProduct(sk, row.product.satsrailProductId);
    if (remote.old_key) throw new IngestionError("ROTATION_PENDING");
    if (remote.status !== "active") throw new IngestionError("PRODUCT_REQUIRED");
    const keys = await satsrail.getProductKey(sk, row.product.satsrailProductId);
    const key = Buffer.from(keys.key, "base64url");
    try {
      // SatsRail fingerprints the base64url key string, matching client-crypto.
      if (key.length !== 32 || sha256(keys.key) !== keys.key_fingerprint || keys.key_fingerprint !== row.keyFingerprint) throw new IngestionError("KEY_STATE_CHANGED");
      const mediaKey = unwrapDek(row.media.envelope!.wrappedDek!);
      try {
        const unwrapped = decryptSourceUrl(row.encryptedDek, keys.key, row.product.satsrailProductId);
        if (sha256(Buffer.from(unwrapped, "base64url")) !== sha256(mediaKey)) throw new IngestionError("KEY_STATE_CHANGED");
      } finally { mediaKey.fill(0); }
    } finally { key.fill(0); }
    // Check once more after fetching the key; no remote operation is performed
    // inside a database lock. Rotation after this check still preserves the DEK.
    if ((await satsrail.getProduct(sk, row.product.satsrailProductId)).old_key) throw new IngestionError("ROTATION_PENDING");
    return { productId, productFingerprint: keys.key_fingerprint,
      bindingFingerprint: sha256(JSON.stringify([row.id, row.encryptedDek, row.keyFingerprint, row.product.keyFingerprint, row.product.mediaId, row.product.channelId])),
      envelopeId: row.media.envelope!.id, envelopeKeyFingerprint: sha256(row.media.envelope!.wrappedDek!) };
  } catch (err) {
    if (err instanceof IngestionError) throw err;
    throw new IngestionError("KEY_SERVICE_UNAVAILABLE", 503, true);
  }
}
export async function assertLocalBinding(tx: Prisma.TransactionClient, mediaId: string, binding: Binding) {
  const row = await localBinding(tx, mediaId, binding.productId);
  if (row.media.envelope!.id !== binding.envelopeId || sha256(row.media.envelope!.wrappedDek!) !== binding.envelopeKeyFingerprint ||
      row.keyFingerprint !== binding.productFingerprint ||
      sha256(JSON.stringify([row.id, row.encryptedDek, row.keyFingerprint, row.product.keyFingerprint, row.product.mediaId, row.product.channelId])) !== binding.bindingFingerprint) throw new IngestionError("KEY_STATE_CHANGED");
  return row.media.envelope!;
}
export function bindingFrom(upload: { productId: string | null; productFingerprint: string | null; bindingFingerprint: string | null; envelopeId: string | null; envelopeKeyFingerprint: string | null }): Binding {
  if (!upload.productId || !upload.productFingerprint || !upload.bindingFingerprint || !upload.envelopeId || !upload.envelopeKeyFingerprint) throw new IngestionError("KEY_STATE_CHANGED");
  return { productId: upload.productId, productFingerprint: upload.productFingerprint, bindingFingerprint: upload.bindingFingerprint, envelopeId: upload.envelopeId, envelopeKeyFingerprint: upload.envelopeKeyFingerprint };
}
