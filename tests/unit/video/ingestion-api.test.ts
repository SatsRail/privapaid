import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { ownerVideoApi, smallJson } from "@/lib/video/api";
import { PUT } from "@/app/api/admin/video-pipeline/uploads/[id]/parts/route";
const auth = vi.hoisted(() => ({ owner: true }));
vi.mock("@/lib/auth-helpers", () => ({ requireOwnerApi: async () => auth.owner ? { id: "owner" } : NextResponse.json({ error: "Forbidden" }, { status: 403 }) }));
const parts = vi.hoisted(() => ({ receive: vi.fn(async () => ({ id: "safe-status" })) }));
vi.mock("@/lib/video/uploads", () => ({ receivePart: parts.receive, uploadView: (value: unknown) => value }));
vi.mock("@/lib/video/storage", () => ({ videoStorage: () => ({}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); auth.owner = true; });
describe("owner video API boundary", () => {
  it("requires owner, feature opt-in and exact canonical origin before mutation", async () => {
    const action = vi.fn(async () => ({})), req = new Request("http://localhost:3000/upload", { method: "POST", headers: { origin: "http://localhost:3000" } });
    auth.owner = false; expect((await ownerVideoApi(req, true, action)).status).toBe(403);
    auth.owner = true; vi.stubEnv("VIDEO_PIPELINE_ENABLED", "false"); expect((await ownerVideoApi(req, true, action)).status).toBe(404);
    vi.stubEnv("VIDEO_PIPELINE_ENABLED", "true");
    expect((await ownerVideoApi(new Request(req.url, { method: "POST" }), true, action)).status).toBe(403);
    expect((await ownerVideoApi(new Request(req.url, { headers: { origin: "https://intruder.test" } }), true, action)).status).toBe(403);
    expect(action).not.toHaveBeenCalled(); expect((await ownerVideoApi(req, true, action)).status).toBe(200);
  });
  it("bounds JSON and sanitizes storage or key exceptions", async () => {
    vi.stubEnv("VIDEO_PIPELINE_ENABLED", "true");
    const req = new Request("http://localhost:3000/upload", { method: "POST", body: "x".repeat(4097) });
    await expect(smallJson(req)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    const response = await ownerVideoApi(new Request(req.url), false, async () => { throw new Error("sensitive key and provider path"); });
    expect(await response.text()).not.toContain("sensitive"); expect(response.status).toBe(503);
  });
  it("forwards the documented raw part checksum without multipart buffering", async () => {
    vi.stubEnv("VIDEO_PIPELINE_ENABLED", "true");
    const request = new Request("http://localhost:3000/part", { method: "PUT", body: new Uint8Array([1]), headers: {
      origin: "http://localhost:3000", "content-type": "application/octet-stream", "upload-offset": "8388608", "x-content-sha256": "a".repeat(64) } });
    expect((await PUT(request, { params: Promise.resolve({ id: "upload-id" }) })).status).toBe(200);
    expect(parts.receive.mock.calls[0].slice(0, 4)).toEqual(["upload-id", "owner", 8388608, "a".repeat(64)]);
  });
});
