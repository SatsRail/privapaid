import { createVideoPlayer, type VideoPlayerHandle } from "../../src/lib/video/browser-player";
declare global {
  interface Window {
    testPlayer: { states: string[]; errors: string[]; waiting: number[]; maxBuffer: number; frames: number; ready: boolean; handle?: VideoPlayerHandle };
  }
}
const video = document.querySelector("video")!;
const metrics = window.testPlayer = { states: [], errors: [], waiting: [], maxBuffer: 0, frames: 0, ready: false } as Window["testPlayer"];
const id = new URL(location.href).searchParams.get("movie")!;
video.addEventListener("waiting", () => { if (video.currentTime > 0.2 && !video.seeking) metrics.waiting.push(video.currentTime); });
function frame() {
  metrics.frames++;
  for (let i = 0; i < video.buffered.length; i++) metrics.maxBuffer = Math.max(metrics.maxBuffer, video.buffered.end(i) - video.buffered.start(i));
  video.requestVideoFrameCallback(frame);
}
video.requestVideoFrameCallback(frame);
document.querySelector("button")!.addEventListener("click", () => {
  const player = createVideoPlayer(video, id, s => metrics.states.push(s)); metrics.handle = player.handle;
  void player.ready.then(async () => { metrics.ready = true; await video.play(); }).catch(e => metrics.errors.push(e.message));
}, { once: true });
