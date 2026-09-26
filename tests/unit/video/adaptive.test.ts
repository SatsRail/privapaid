import { describe, expect, it } from "vitest";
import { qualityLadder, videoEstimate } from "@/lib/video/quality";
describe("adaptive encoding profiles and estimates", () => {
  it("uses three bounded qualities and never upscales or duplicates native sizes", () => {
    expect(qualityLadder(1920, 1080).map(r => r.height)).toEqual([360, 480, 720]);
    expect(qualityLadder(320, 180).map(r => [r.width, r.height])).toEqual([[320, 180]]);
    expect(qualityLadder(960, 540).map(r => r.height)).toEqual([360, 480, 540]);
    for (const [w, h] of [[1080, 1920], [2048, 858], [17, 19]]) for (const q of qualityLadder(w, h)) {
      expect(q.width).toBeLessThanOrEqual(w); expect(q.height).toBeLessThanOrEqual(h);
      expect(q.width % 2).toBe(0); expect(q.height % 2).toBe(0);
    }
  });
  it("estimates media requests separately from quality/storage work", () => {
    const four = videoEstimate(7200, 1920, 1080, 4)!, ten = videoEstimate(7200, 1920, 1080, 10)!;
    expect(four.viewerRequests).toBe(3604); expect(ten.viewerRequests).toBe(1444);
    expect(four.outputBytes).toBe(ten.outputBytes);
    expect(four.storedObjects).toBe(7206);
    expect(videoEstimate(14400, 1920, 1080, 4)!.storedObjects).toBeLessThan(15000);
    expect(videoEstimate(7200, 1920, 1080, 5)).toBeNull();
  });
});
