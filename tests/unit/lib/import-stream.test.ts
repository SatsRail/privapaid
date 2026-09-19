import { describe, expect, it, vi } from "vitest";
import { importResponseError, readImportStream } from "@/lib/import-stream";

function reader(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    chunks.forEach((chunk) => controller.enqueue(chunk));
    controller.close();
  } }).getReader();
}

describe("import progress stream", () => {
  const wire = 'event: progress\r\ndata: {"name":"Café"}\r\n\r\nevent: complete\ndata: {"success":true}\n\n';
  it("handles every byte boundary, including split UTF-8 and event/data lines", async () => {
    const bytes = new TextEncoder().encode(wire);
    for (let split = 1; split < bytes.length; split++) {
      const callback = vi.fn();
      await readImportStream(reader([bytes.slice(0, split), bytes.slice(split)]), callback);
      expect(callback.mock.calls).toEqual([["progress", { name: "Café" }], ["complete", { success: true }]]);
    }
  });
  it("handles one-byte chunks", async () => {
    const callback = vi.fn();
    await readImportStream(reader(Array.from(new TextEncoder().encode(wire), b => Uint8Array.of(b))), callback);
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("reports EOF without a terminal frame and releases the reader", async () => {
    const streamReader = reader([new TextEncoder().encode('event: progress\ndata: {}\n\n')]);
    const release = vi.spyOn(streamReader, "releaseLock");
    await expect(readImportStream(streamReader, vi.fn())).rejects.toThrow("before confirmation");
    expect(release).toHaveBeenCalled();
  });
  it("delivers a fatal error frame", async () => {
    const callback = vi.fn();
    await readImportStream(reader([new TextEncoder().encode('event: error\ndata: {"error":"Failed"}\n\n')]), callback);
    expect(callback).toHaveBeenCalledWith("error", { error: "Failed" });
  });
  it("surfaces field-specific validation errors", () => {
    expect(importResponseError({ error: "Validation failed", issues: [{ path: "media.0.media_type", message: "Use photo upload" }] })).toContain("media.0.media_type: Use photo upload");
  });
});
