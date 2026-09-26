import { describe, expect, it } from "vitest";
import { videoEnabled, videoConfig, storageIdentity } from "@/lib/video/config";
const base = { VIDEO_PIPELINE_ENABLED: "true", CONTENT_KEK: Buffer.alloc(32).toString("base64") };
describe("optional video configuration", () => {
  it("is disabled by default without requiring cloud credentials", () => {
    expect(videoEnabled({})).toBe(false);
    expect(() => videoConfig({})).toThrow("VIDEO_DISABLED");
    expect(videoConfig(base).provider).toBe("local");
  });
  it("reports actionable missing-key and storage errors", () => {
    expect(() => videoConfig({ VIDEO_PIPELINE_ENABLED: "true" })).toThrow("VIDEO_CONTENT_KEK_REQUIRED");
    expect(() => videoConfig({ ...base, CONTENT_KEK: "not-a-key" })).toThrow("VIDEO_CONTENT_KEK_REQUIRED");
    expect(() => videoConfig({ ...base, VIDEO_STORAGE_PROVIDER: "s3" })).toThrow("VIDEO_S3_BUCKET_AND_REGION_REQUIRED");
    expect(() => videoConfig({ ...base, VIDEO_LOCAL_ROOT: "public/video" })).toThrow("PRIVATE_ABSOLUTE_PATH");
  });
  it("rejects insecure endpoints and unbounded lease values", () => {
    expect(() => videoConfig({ ...base, VIDEO_S3_ENDPOINT: "http://remote.example" })).toThrow("ENDPOINT_INVALID");
    expect(() => videoConfig({ ...base, VIDEO_S3_ENDPOINT: "https://secret:pass@example.com" })).toThrow("ENDPOINT_INVALID");
    expect(() => videoConfig({ ...base, VIDEO_JOB_LEASE_SECONDS: "0" })).toThrow("LEASE_INVALID");
  });
  it("binds readiness to the store without including AWS credentials", () => {
    const config = videoConfig(base);
    expect(storageIdentity(config)).toMatch(/^[a-f0-9]{64}$/);
    expect(storageIdentity({ ...config, localRoot: "/tmp/another-store" })).not.toBe(storageIdentity(config));
  });
});
