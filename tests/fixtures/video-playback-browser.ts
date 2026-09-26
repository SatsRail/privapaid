import { createVideoPlayer, type QualityState, type VideoPlayerHandle } from "../../src/lib/video/browser-player";
declare global {
  interface Window {
    testPlayer: { states: string[]; errors: string[]; waiting: number[]; maxBuffer: number; frames: number; ready: boolean; qualities: QualityState[]; heights: number[]; blackFrames: number; handle?: VideoPlayerHandle };
  }
}
const video = document.querySelector("video")!;
const metrics = window.testPlayer = { states: [], errors: [], waiting: [], maxBuffer: 0, frames: 0, ready: false, qualities: [], heights: [], blackFrames: 0 } as Window["testPlayer"];
const id = new URL(location.href).searchParams.get("movie")!;
video.addEventListener("waiting", () => { if (video.currentTime > 0.2 && !video.seeking) metrics.waiting.push(video.currentTime); });
const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
const pixels = canvas.getContext("2d", { willReadFrequently: true })!;
function frame() {
  if (!metrics.heights.includes(video.videoHeight)) metrics.heights.push(video.videoHeight);
  pixels.drawImage(video, 0, 0, 8, 8);
  const values = pixels.getImageData(0, 0, 8, 8).data;
  if (values.every((n, i) => i % 4 === 3 || n < 8)) metrics.blackFrames++;
  metrics.frames++;
  for (let i = 0; i < video.buffered.length; i++) metrics.maxBuffer = Math.max(metrics.maxBuffer, video.buffered.end(i) - video.buffered.start(i));
  video.requestVideoFrameCallback(frame);
}
video.requestVideoFrameCallback(frame);
document.querySelector("button")!.addEventListener("click", () => {
  const player = createVideoPlayer(video, id, s => metrics.states.push(s), undefined, undefined, q => metrics.qualities.push(q)); metrics.handle = player.handle;
  void player.ready.then(async () => { metrics.ready = true; await video.play(); }).catch(e => metrics.errors.push(e.message));
}, { once: true });
