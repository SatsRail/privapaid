import shaka from "shaka-player";
import { decryptObject, digest, openDescriptor, readCatalog, validateManifest, type CatalogEntry, type Descriptor } from "./browser-crypto";
import { PlaybackLease, type SessionState } from "./browser-session";
import { MAX_CIPHER_BYTES, OUTPUT_NAME, type PlaybackSession } from "./playback-contract";

class CipherReader {
  private active = 0;
  private waiters: Array<() => void> = [];
  private root?: CryptoKey;
  private descriptor?: Descriptor;
  private entries = new Map<string, CatalogEntry>();
  constructor(private lease: PlaybackLease) {}
  async init() {
    const opened = await openDescriptor(this.lease.current);
    this.lease.signal.throwIfAborted();
    this.root = opened.root; this.descriptor = opened.descriptor;
    const wire = await this.fetchCipher("catalog.json", 4 * 1024 * 1024, AbortSignal.any([this.lease.signal, AbortSignal.timeout(30000)]));
    const plain = await decryptObject(this.root, this.descriptor, "catalog.json", wire, this.descriptor.catalog.sha256);
    this.entries = readCatalog(plain, this.descriptor);
  }
  private async fetchCipher(name: string, max: number, signal: AbortSignal, progress?: (ms: number, bytes: number, remaining: number) => void) {
    await this.lease.ensure();
    let sampledAt = performance.now(), pendingBytes = 0;
    const res = await fetch(`${this.lease.current.objectBase}${name}`, { credentials: "include", cache: "no-store", redirect: "error", signal });
    if (!res.ok) throw new Error("VIDEO_DELIVERY_UNAVAILABLE");
    if (!res.body || Number(res.headers.get("Content-Length")) > max) { await res.body?.cancel(); throw new Error("VIDEO_INTEGRITY"); }
    const reader = res.body.getReader(), parts: Uint8Array[] = []; let count = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        count += value.byteLength; if (count > max) throw new Error("VIDEO_INTEGRITY"); parts.push(value);
        pendingBytes += value.byteLength;
        if (performance.now() - sampledAt >= 250 && pendingBytes >= 16384) {
          progress?.(Math.max(1, performance.now() - sampledAt), pendingBytes, Math.max(0, max - count));
          sampledAt = performance.now(); pendingBytes = 0;
        }
      }
      if (pendingBytes) progress?.(Math.max(1, performance.now() - sampledAt), pendingBytes, 0);
      const wire = new Uint8Array(count); let offset = 0;
      for (const part of parts) { wire.set(part, offset); offset += part.length; }
      return wire;
    } finally { for (const part of parts) part.fill(0); await reader.cancel().catch(() => {}); }
  }
  async read(name: string, signal: AbortSignal, progress?: (ms: number, bytes: number, remaining: number) => void) {
    if (!OUTPUT_NAME.test(name) || !this.entries.has(name)) throw new Error("VIDEO_INTEGRITY");
    // At most two decrypt/fetch operations. Waiting requests hold no media
    // bytes. Shaka's buffer goal and disabled prefetch bound plaintext retention.
    while (this.active >= 2) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { signal.removeEventListener("abort", abort); const i = this.waiters.indexOf(wake); if (i >= 0) this.waiters.splice(i, 1); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
        this.waiters.push(wake); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted(); this.active++;
    try {
      const entry = this.entries.get(name)!;
      const wire = await this.fetchCipher(name, Math.min(MAX_CIPHER_BYTES, entry.encryptedBytes), signal, progress);
      const plain = await decryptObject(this.root!, this.descriptor!, name, wire, entry.encryptedSha256);
      try {
        if (plain.length !== entry.bytes || await digest(plain) !== entry.sha256) throw new Error("VIDEO_INTEGRITY");
        if (name === "play.mpd") validateManifest(plain);
        signal.throwIfAborted();
        return plain.buffer;
      } catch (error) { plain.fill(0); throw error; }
    } finally { this.active--; this.waiters.shift()?.(); }
  }
  destroy() { this.root = undefined; this.descriptor = undefined; this.entries.clear(); }
}
export type QualityState = { automatic: boolean; activeId?: number; options: { id: number; height: number; width: number; bandwidth: number }[] };
export type VideoPlayerHandle = { retry(): Promise<void>; version(): string | undefined; quality(id: number | "auto"): void; destroy(): Promise<void> };
export function createVideoPlayer(video: HTMLVideoElement, mediaId: string,
  changed: (state: SessionState | "loading" | "unsupported" | "error") => void,
  initial?: { session: PlaybackSession; requestedAt: number }, resume?: { time: number; version?: string },
  qualityChanged?: (state: QualityState) => void): { ready: Promise<void>; handle: VideoPlayerHandle } {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported() || !globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID || !AbortSignal.any || !AbortSignal.timeout) {
    changed("unsupported");
    return { ready: Promise.resolve(), handle: { async retry() {}, version() { return undefined; }, quality() {}, async destroy() {} } };
  }
  const player = new shaka.Player();
  let leaseState: SessionState = "ready", pausedForLease = false;
  const lease = new PlaybackLease(mediaId, state => {
    leaseState = state; changed(state);
    if (state === "denied" || state === "expired") { pausedForLease ||= !video.paused; video.pause(); }
    if (state === "ready" && loaded) {
      player.retryStreaming();
      if (pausedForLease) { pausedForLease = false; void video.play().catch(() => {}); }
    }
  }, resume?.version);
  const reader = new CipherReader(lease);
  const scheme = `ppv-${crypto.randomUUID()}`;
  let destroyed = false, loaded = false;
  const publishQuality = () => {
    if (destroyed) return;
    const tracks = player.getVariantTracks();
    qualityChanged?.({ automatic: player.getConfiguration().abr.enabled, activeId: tracks.find(t => t.active)?.id,
      options: tracks.filter(t => t.height && t.width).map(t => ({ id: t.id, height: t.height!, width: t.width!, bandwidth: t.bandwidth })).sort((a, b) => a.height - b.height) });
  };
  for (const event of ["trackschanged", "variantchanged", "adaptation"]) player.addEventListener(event, publishQuality);
  shaka.net.NetworkingEngine.registerScheme(scheme, (uri, request, _type, progress) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lease.signal, AbortSignal.timeout(30000)]);
    const promise = (async () => {
      const parsed = new URL(uri);
      if (parsed.protocol !== `${scheme}:` || parsed.hostname !== "movie" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("VIDEO_INTEGRITY");
      const data = await reader.read(parsed.pathname.slice(1), signal, progress);
      return { uri, originalUri: uri, originalRequest: request, data, headers: { "content-type": parsed.pathname.endsWith(".mpd") ? "application/dash+xml" : "video/mp4" } };
    })().catch(error => {
      const aborted = controller.signal.aborted || lease.signal.aborted;
      const fatal = error instanceof Error && error.message === "VIDEO_INTEGRITY";
      throw new shaka.util.Error(fatal ? shaka.util.Error.Severity.CRITICAL : shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.NETWORK, aborted ? shaka.util.Error.Code.OPERATION_ABORTED : shaka.util.Error.Code.HTTP_ERROR, "Encrypted video delivery failed");
    });
    return new shaka.util.AbortableOperation(promise, async () => { controller.abort(); });
  });
  player.getNetworkingEngine()!.registerRequestFilter((_type, request) => {
    if (request.uris.some(uri => !uri.startsWith(`${scheme}://movie/`))) throw new Error("VIDEO_INTEGRITY");
  });
  player.configure({ abr: { enabled: true, defaultBandwidthEstimate: 800000, useNetworkInformation: false, switchInterval: 4, clearBufferSwitch: false },
    streaming: { bufferingGoal: 12, rebufferingGoal: 2, bufferBehind: 8, segmentPrefetchLimit: 0,
    stopFetchingOnPause: true, retryParameters: { maxAttempts: 2, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.3, timeout: 35000 } },
    manifest: { retryParameters: { maxAttempts: 2, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.3, timeout: 35000 } } });
  player.addEventListener("error", () => { if (!destroyed) changed(leaseState === "ready" ? "error" : leaseState); });
  const ready = (async () => {
    changed("loading");
    await lease.start(initial); await reader.init();
    if (destroyed) return;
    await player.attach(video); await player.load(`${scheme}://movie/play.mpd`, resume?.time, "application/dash+xml"); loaded = true;
    if (!destroyed) { changed("ready"); publishQuality(); }
  })();
  return { ready, handle: {
    async retry() { await lease.renew(); if (loaded) player.retryStreaming(); },
    version() { try { return lease.current.version; } catch { return undefined; } },
    quality(id) {
      if (!loaded || destroyed) return;
      if (id === "auto") player.configure({ abr: { enabled: true } });
      else {
        const track = player.getVariantTracks().find(t => t.id === id); if (!track) return;
        player.configure({ abr: { enabled: false } }); player.selectVariantTrack(track, false);
      }
      publishQuality();
    },
    async destroy() { destroyed = true; lease.destroy(); await player.destroy(); reader.destroy(); shaka.net.NetworkingEngine.unregisterScheme(scheme); video.removeAttribute("src"); video.load(); },
  } };
}
