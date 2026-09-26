import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { adaptiveFixture } from "../../helpers/adaptive-video";
import { validateTimelines, validateManifest } from "@/lib/video/validation";
import { ingestionConfig } from "@/lib/video/ingestion-config";
import { sha256 } from "@/lib/video/format";
import type { MediaBridge } from "@/lib/video/bridge";
describe("real adaptive FFmpeg output", () => {
  it.each([[4, "gaps"], [10, "silent"]] as const)("aligns %s-second qualities for %s sources", async (segment, mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "ppv-ladder-"));
    try {
      const { objects, source } = await adaptiveFixture(root, segment, 21, mode);
      const map = new Map(Object.entries(objects).filter(([name]) => name !== "play.mpd").map(([name, plain]) => [name,
        { name, bytes: plain.length, encryptedBytes: plain.length + 32, sha256: sha256(plain), encryptedSha256: "a".repeat(64) }]));
      const bridge: Pick<MediaBridge, "objects" | "read"> = { objects: map, read: async object => Buffer.from(objects[object.name]) };
      const manifest = objects["play.mpd"].toString();
      const tracks = validateManifest(manifest, bridge, source);
      expect(tracks.filter(t => t.video)).toHaveLength(3);
      await validateTimelines(bridge, manifest, source, segment, ingestionConfig(), new AbortController().signal);
      expect(() => validateManifest(manifest.replace('height="720"', 'height="722"'), bridge, source)).toThrow();
      const target = tracks.filter(t => t.video)[1].names.at(-1)!; map.delete(target);
      expect(() => validateManifest(manifest, bridge, source)).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
