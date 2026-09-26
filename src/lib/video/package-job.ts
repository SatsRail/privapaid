import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { unwrapDek } from "@/lib/content-dek";
import { completeJob, lockLease, type Lease, LeaseLostError } from "./jobs";
import { videoConfig, type VideoConfig } from "./config";
import { ingestionConfig } from "./ingestion-config";
import { IngestionError } from "./ingestion-errors";
import { ownedUpload, assertStore, readSourcePart } from "./uploads";
import { verifyProductBinding, assertLocalBinding, bindingFrom, type Binding } from "./product-gate";
import { privateMediaBridge } from "./bridge";
import { probeSource, validateTimelines } from "./validation";
import { mediaProcess, safeInputArgs } from "./process";
import { encryptDescriptor } from "./format";
import type { VideoStorage } from "./storage/types";

async function progress(job: Lease, value: number) {
  const n = await prisma.$executeRaw`UPDATE "VideoAssetVersion" SET progress = ${value}, "updatedAt" = clock_timestamp()
    WHERE id = ${job.versionId}::uuid AND status = 'processing' AND EXISTS (
      SELECT 1 FROM "VideoJob" WHERE id = ${job.id}::uuid AND "leaseToken" = ${job.leaseToken}::uuid
        AND status = 'running' AND "leaseExpiresAt" > clock_timestamp())`;
  if (!n) throw new LeaseLostError();
}
export async function packageVideo(job: Lease, storage: VideoStorage, signal: AbortSignal, config: VideoConfig = videoConfig()) {
  const session = await prisma.videoUploadSession.findUnique({ where: { versionId: job.versionId! } });
  if (!session) throw new IngestionError("INVALID_UPLOAD");
  const upload = await ownedUpload(session.id, session.ownerId); assertStore(upload, config);
  if (upload.status !== "completed" || upload.receivedBytes !== upload.expectedBytes || upload.version.sourceCleanedAt) throw new IngestionError("SOURCE_EXPIRED");
  const before = await verifyProductBinding(upload.version.asset.mediaId, upload.productId!);
  if (!sameBinding(before, bindingFrom(upload))) throw new IngestionError("KEY_STATE_CHANGED");
  const limits = ingestionConfig(), hash = createHash("sha256"), key = unwrapDek(upload.version.wrappedRootKey);
  try {
    for (let index = 0; index < Math.ceil(Number(upload.expectedBytes) / upload.partBytes); index++) {
      signal.throwIfAborted(); const data = await readSourcePart(storage, upload, index, key, signal);
      try { hash.update(data); } finally { data.fill(0); }
    }
  } finally { key.fill(0); }
  const sourceSha256 = hash.digest("hex");
  if (upload.sourceSha256 && upload.sourceSha256 !== sourceSha256) throw new IngestionError("OUTPUT_INVALID");
  await prisma.videoUploadSession.update({ where: { id: upload.id }, data: { sourceSha256 } });
  await progress(job, 10);
  const bridge = await privateMediaBridge(upload, job, storage, signal);
  try {
    const source = await probeSource(bridge.sourceUrl, limits, signal);
    await progress(job, 15);
    let last = 0, updating: Promise<void> | undefined, progressError: unknown;
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "134217728",
      "-threads", String(limits.threads), ...safeInputArgs, "-i", bridge.sourceUrl,
      "-map", "0:v:0", ...(source.audio ? ["-map", "0:a:0"] : []), "-map_metadata", "-1", "-map_chapters", "-1",
      "-filter_threads", "1", "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
      "-c:v", "libx264", "-threads", String(limits.threads), "-preset", "veryfast", "-crf", "23", "-maxrate", "4M", "-bufsize", "8M",
      "-pix_fmt", "yuv420p", "-profile:v", "main", "-level:v", "3.1", "-g", String(upload.version.segmentSeconds * 30),
      "-keyint_min", String(upload.version.segmentSeconds * 30), "-sc_threshold", "0", "-bf", "0",
      ...(source.audio ? ["-af", "apad", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-shortest"] : []),
      "-t", String(source.duration), "-progress", "pipe:1", "-nostats", "-f", "dash", "-seg_duration", String(upload.version.segmentSeconds),
      "-use_template", "1", "-use_timeline", "1", "-adaptation_sets", source.audio ? "id=0,streams=v id=1,streams=a" : "id=0,streams=v",
      "-init_seg_name", "init-$RepresentationID$.mp4", "-media_seg_name", "segment-$RepresentationID$-$Number%05d$.m4s",
      "-method", "PUT", "-timeout", "30", bridge.outputUrl];
    await mediaProcess(limits.ffmpeg, args, { signal, line(line) {
      if (progressError) throw progressError;
      if (line.startsWith("out_time_us=") && Date.now() - last > 1000 && !updating) {
        const seconds = Number(line.slice(12)) / 1e6;
        if (!Number.isFinite(seconds)) return;
        last = Date.now();
        updating = progress(job, Math.min(85, 15 + Math.floor(70 * seconds / source.duration)))
          .catch(err => { progressError = err; }).finally(() => { updating = undefined; });
      }
    } });
    await updating; if (progressError) throw progressError;
    const manifest = await bridge.finish();
    try {
      await progress(job, 90);
      await validateTimelines(bridge, manifest.toString("utf8"), source, upload.version.segmentSeconds, limits, signal);
      const manifestObject = await bridge.persist("play.mpd", manifest);
      const catalogBytes = Buffer.from(JSON.stringify({ format: 1, asset: upload.version.assetId, version: upload.versionId,
        attempt: job.leaseToken, objects: [...bridge.objects.values()].sort((a, b) => a.name.localeCompare(b.name)) }));
      let catalog;
      try { catalog = await bridge.persist("catalog.json", catalogBytes); } finally { catalogBytes.fill(0); }
      // Authenticate final metadata after storage too, before the pointer switch.
      (await bridge.read(manifestObject)).fill(0); (await bridge.read(catalog)).fill(0);
      const fresh = await verifyProductBinding(upload.version.asset.mediaId, upload.productId!);
      if (!sameBinding(fresh, bindingFrom(upload))) throw new IngestionError("KEY_STATE_CHANGED");
      signal.throwIfAborted();
      await prisma.$transaction(async tx => {
        await lockLease(tx, job);
        // Lock the local access chain against edits/deletion during publication.
        await tx.$queryRaw`SELECT id FROM "Media" WHERE id = ${upload.version.asset.mediaId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Channel" WHERE id = (SELECT "channelId" FROM "Media" WHERE id = ${upload.version.asset.mediaId}) FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "MediaEnvelope" WHERE id = ${fresh.envelopeId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${fresh.productId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "MediaProduct" WHERE "mediaId" = ${upload.version.asset.mediaId} AND "productId" = ${fresh.productId} FOR UPDATE`;
        const envelope = await assertLocalBinding(tx, upload.version.asset.mediaId, fresh);
        await tx.$queryRaw`SELECT id FROM "VideoAsset" WHERE id = ${upload.version.assetId}::uuid FOR UPDATE`;
        const asset = await tx.videoAsset.findUniqueOrThrow({ where: { id: upload.version.assetId } });
        if (asset.generation !== upload.version.generation) throw new IngestionError("KEY_STATE_CHANGED");
        const root = unwrapDek(upload.version.wrappedRootKey), mediaKey = unwrapDek(envelope.wrappedDek!);
        let descriptor: Buffer;
        try {
          descriptor = encryptDescriptor(mediaKey, upload.version.assetId, upload.versionId, { format: 1,
            asset: upload.version.assetId, version: upload.versionId, attempt: job.leaseToken, rootKey: root.toString("base64url"),
            prefix: bridge.prefix, manifest: { name: "play.mpd", sha256: manifestObject.encryptedSha256 },
            catalog: { name: "catalog.json", sha256: catalog.encryptedSha256 } });
        } finally { root.fill(0); mediaKey.fill(0); }
        const encryptedBytes = [...bridge.objects.values()].reduce((sum, o) => sum + BigInt(o.encryptedBytes), BigInt(0));
        await tx.videoAssetVersion.update({ where: { id: upload.versionId }, data: { status: "ready", progress: 100,
          manifestKey: `${bridge.prefix}/play.mpd`, manifestSha256: manifestObject.encryptedSha256,
          encryptedDescriptor: new Uint8Array(descriptor), objectCount: bridge.objects.size, encryptedBytes,
          durationMs: BigInt(Math.round(source.duration * 1000)), readyAt: new Date() } });
        await tx.videoAsset.update({ where: { id: asset.id }, data: { publishedVersionId: upload.versionId } });
        // Preserve legacy MediaEnvelope.bytes/player until Phase 3 consumes the
        // separate encrypted version descriptor through the existing DEK chain.
        await completeJob(job, tx);
      });
    } finally { manifest.fill(0); }
  } finally { await bridge.close(); }
}
function sameBinding(a: Binding, b: Binding) { return (Object.keys(a) as (keyof Binding)[]).every(key => a[key] === b[key]); }
