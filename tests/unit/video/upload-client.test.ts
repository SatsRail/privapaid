import { afterEach, expect, it, vi } from "vitest";
import { fileFingerprint, transferFile, type UploadStatus } from "@/lib/video/upload-client";
afterEach(() => vi.unstubAllGlobals());
it("resumes at the acknowledged offset and completes only after every part", async () => {
  const file = new File(["abcdefghij"], "movie.mp4");
  const upload = { id: "resume-id", bytes: file.size, receivedBytes: 4, partBytes: 4, clientFingerprint: await fileFingerprint(file) } as UploadStatus;
  const offsets: string[] = [], bodies: string[] = [];
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/complete")) return Response.json({ ...upload, status: "queued", receivedBytes: 10 });
    const headers = options.headers as Record<string, string>; offsets.push(headers["Upload-Offset"]);
    expect(headers["X-Content-SHA256"]).toMatch(/^[a-f0-9]{64}$/);
    bodies.push(new TextDecoder().decode(options.body as Uint8Array));
    return Response.json({ ...upload, receivedBytes: Number(offsets.at(-1)) + (options.body as Uint8Array).length });
  }); vi.stubGlobal("fetch", fetcher);
  const ack = vi.fn(); expect((await transferFile(file, upload, new AbortController().signal, ack)).status).toBe("queued");
  expect(offsets).toEqual(["4", "8"]); expect(bodies).toEqual(["efgh", "ij"]); expect(ack).toHaveBeenCalledTimes(2);
});
it("rejects a different file and stops cleanly without completing an aborted transfer", async () => {
  const file = new File(["original"], "movie.mp4"), upload = { id: "id", bytes: file.size, receivedBytes: 0, partBytes: 4, clientFingerprint: await fileFingerprint(file) } as UploadStatus;
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(transferFile(new File(["modified"], "movie.mp4"), upload, new AbortController().signal, vi.fn())).rejects.toThrow("original file");
  const stop = new AbortController(); stop.abort(); await expect(transferFile(file, upload, stop.signal, vi.fn())).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
