import type { Readable } from "node:stream";
import { IngestionError } from "./ingestion-errors";
export async function boundedBytes(stream: AsyncIterable<Uint8Array>, max: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > max) throw new IngestionError("INVALID_UPLOAD", 413);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
export async function objectBytes(stream: Readable, max: number, signal?: AbortSignal) {
  const abort = () => stream.destroy(new Error("Aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  try { signal?.throwIfAborted(); return await boundedBytes(stream, max, signal); }
  finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
}
