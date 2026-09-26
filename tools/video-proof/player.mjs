import { decryptObject, importRoot, MAX_OBJECT_BYTES } from './format.mjs';
const video = document.querySelector('#video');
const metrics = { version: shaka.Player.version, decrypted: 0, decryptedBytes: 0,
  decryptMs: [], errors: [], waiting: [], frames: 0, maxFrameGap: 0, maxBufferAhead: 0, maxBufferedSpan: 0 };
let player, session, started, lastFrame;
window.proof = { metrics, video, start };
shaka.polyfill.installAll();

async function start() {
  document.querySelector('#start').disabled = true;
  try {
    session = await (await fetch('/session', { cache: 'no-store' })).json();
    const raw = Uint8Array.from(atob(session.key), c => c.charCodeAt(0));
    const root = await importRoot(raw); raw.fill(0); delete session.key;
    const objects = new Map(session.objects.map(o => [o.name, o]));
    const prefix = `/objects/${session.asset}/${session.version}/`;
    player = new shaka.Player(); await player.attach(video);
    window.proof.player = player;
    player.configure({ streaming: { bufferingGoal: 12, rebufferingGoal: 2, bufferBehind: 8,
      alwaysStreamText: false }, manifest: { dash: { autoCorrectDrift: false } } });
    player.addEventListener('error', event => { metrics.errors.push(String(event.detail.code)); render(); });
    const network = player.getNetworkingEngine();
    network.registerRequestFilter((_type, request) => {
      for (const uri of request.uris) {
        const url = new URL(uri);
        if (url.origin !== location.origin || !url.pathname.startsWith(prefix) ||
            url.search || url.hash || !objects.has(url.pathname.slice(prefix.length))) {
          throw new Error('Request outside authenticated fixture inventory');
        }
      }
    });
    // Decrypt before handing any manifest/init/segment bytes to Shaka. Its native
    // HLS GCM path has a different layout and no AAD; this adapter preserves both.
    network.registerResponseFilter(async (_type, response) => {
      const url = new URL(response.originalUri || response.uri);
      const name = url.pathname.slice(prefix.length), expected = objects.get(name);
      if (!expected || response.data.byteLength > MAX_OBJECT_BYTES + 32) throw new Error('Unknown/oversize object');
      const start = performance.now();
      const bytes = await decryptObject(new Uint8Array(response.data), root, session.asset, session.version, name);
      if (bytes.length !== expected.bytes) throw new Error('Object size mismatch');
      metrics.decryptMs.push(performance.now() - start);
      metrics.decrypted++; metrics.decryptedBytes += bytes.length;
      response.data = bytes.buffer;
    });
    const load = performance.now();
    await player.load(`${location.origin}${prefix}play.mpd`, 0, 'application/dash+xml');
    await video.play();
    metrics.startupMs = performance.now() - load;
    started = true;
    document.querySelector('#status').textContent = 'Playing authenticated video';
  } catch (error) {
    metrics.errors.push(String(error)); document.querySelector('#status').textContent = 'Playback failed';
    document.querySelector('#start').disabled = false;
  }
  render();
}
function render() {
  document.querySelector('#metrics').textContent = JSON.stringify({ ...metrics,
    decryptMs: metrics.decryptMs.length ? { samples: metrics.decryptMs.length,
      max: Math.max(...metrics.decryptMs) } : [], currentTime: video.currentTime,
    duration: video.duration || null, quality: video.getVideoPlaybackQuality?.() }, null, 2);
}
video.addEventListener('waiting', () => { if (started && !video.seeking) metrics.waiting.push(video.currentTime); });
video.addEventListener('seeking', () => { lastFrame = undefined; });
video.addEventListener('ended', () => {
  metrics.ended = true;
  document.querySelector('#status').textContent = 'Playback completed';
  render();
});
if (video.requestVideoFrameCallback) {
  const frame = (_now, metadata) => {
    if (lastFrame !== undefined && !video.seeking) {
      metrics.maxFrameGap = Math.max(metrics.maxFrameGap, metadata.mediaTime - lastFrame);
    }
    lastFrame = metadata.mediaTime; metrics.frames++;
    video.requestVideoFrameCallback(frame);
  };
  video.requestVideoFrameCallback(frame);
}
setInterval(() => {
  if (video.buffered.length) {
    const end = video.buffered.end(video.buffered.length - 1);
    metrics.maxBufferAhead = Math.max(metrics.maxBufferAhead, end - video.currentTime);
    metrics.maxBufferedSpan = Math.max(metrics.maxBufferedSpan, end - video.buffered.start(0));
  }
  render();
}, 500);
document.querySelector('#start').addEventListener('click', start);
window.addEventListener('pagehide', () => { player?.destroy(); });
