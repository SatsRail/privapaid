import type { PlaybackSession } from "./playback-contract";
export type SessionState = "ready" | "retrying" | "expired" | "denied";
export class SessionFailure extends Error {
  constructor(public denied: boolean, public retryAfterMs = 0) { super(denied ? "ACCESS_DENIED" : "ACCESS_UNAVAILABLE"); }
}
export async function fetchPlaybackSession(mediaId: string, signal: AbortSignal, version?: string): Promise<PlaybackSession> {
  const res = await fetch(`/api/media/${encodeURIComponent(mediaId)}/playback-session`, {
    method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(version ? { version } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!res.ok) {
    const retry = res.headers.get("Retry-After"), seconds = retry && (/^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000);
    throw new SessionFailure([401, 403, 404].includes(res.status), seconds && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0);
  }
  return res.json();
}
// One controller per playing movie. Key verification happens at startup; renewal
// replaces delivery cookies only and must keep the same immutable descriptor.
export class PlaybackLease {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private failures = 0;
  private deadline = 0;
  private nextAllowed = 0;
  private denied = false;
  private closed = false;
  private session?: PlaybackSession;
  constructor(private mediaId: string, private changed: (state: SessionState) => void, private version?: string) {}
  get signal() { return this.controller.signal; }
  get current() { if (!this.session) throw new Error("SESSION_NOT_STARTED"); return this.session; }
  private async install(session: PlaybackSession, started: number) {
    const base = new URL(session.objectBase), grant = new URL(session.grantUrl);
    if (!Number.isSafeInteger(session.serverTime) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= session.serverTime ||
        session.expiresAt - session.serverTime > 300000 || base.origin !== grant.origin ||
        !base.pathname.endsWith(`/${session.prefix}/`) || grant.pathname !== "/api/video-delivery/grant" ||
        !["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || grant.search || grant.hash) throw new Error("INVALID_SESSION");
    if (this.session && ["asset", "version", "attempt", "prefix", "objectBase", "grantUrl", "encryptedDescriptor"].some(k =>
      this.session![k as keyof PlaybackSession] !== session[k as keyof PlaybackSession])) throw new SessionFailure(true);
    // Request-start anchoring subtracts all request latency, including grants.
    const deadline = started + session.expiresAt - session.serverTime - 1000;
    const res = await fetch(session.grantUrl, { method: "POST", credentials: "include", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "text/plain" }, body: JSON.stringify(session.grant), signal: AbortSignal.any([this.signal, AbortSignal.timeout(10000)]) });
    if (!res.ok) throw new SessionFailure(false);
    if (this.closed) throw new DOMException("Aborted", "AbortError");
    if (deadline <= performance.now()) throw new SessionFailure(false);
    this.session = session; this.deadline = deadline; this.failures = 0; this.nextAllowed = 0;
    this.changed("ready"); this.schedule(Math.max(1000, (deadline - performance.now()) * (0.65 + Math.random() * 0.15)));
  }
  async start(initial?: { session: PlaybackSession; requestedAt: number }) {
    const started = initial?.requestedAt ?? performance.now();
    await this.install(initial?.session ?? await fetchPlaybackSession(this.mediaId, this.signal, this.version), started);
    return this.current;
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.closed) this.timer = setTimeout(() => { void this.renew().catch(() => {}); }, Math.min(delay, 2 ** 31 - 1));
  }
  renew(): Promise<void> {
    if (this.closed) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.denied) return Promise.reject(new SessionFailure(true));
    if (this.pending) return this.pending;
    if (performance.now() < this.nextAllowed) return Promise.reject(new SessionFailure(false, this.nextAllowed - performance.now()));
    this.pending = (async () => {
      const started = performance.now();
      try { await this.install(await fetchPlaybackSession(this.mediaId, this.signal, this.current.version), started); }
      catch (error) {
        if (this.closed) throw error;
        if (error instanceof SessionFailure && error.denied) { this.denied = true; this.deadline = 0; this.changed("denied"); clearTimeout(this.timer); }
        else {
          const delay = Math.max(error instanceof SessionFailure ? error.retryAfterMs : 0,
            Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)) * (0.8 + Math.random() * 0.4));
          this.nextAllowed = performance.now() + delay;
          this.changed(performance.now() >= this.deadline ? "expired" : "retrying"); this.schedule(delay);
        }
        throw error;
      } finally { this.pending = undefined; }
    })();
    return this.pending;
  }
  async ensure() {
    if (this.denied || this.closed) throw new SessionFailure(true);
    if (performance.now() >= this.deadline) { this.changed("expired"); await this.renew(); }
  }
  destroy() { this.closed = true; clearTimeout(this.timer); this.controller.abort(); this.session = undefined; this.deadline = 0; }
}
