// Server-only Web Push fan-out. Imported only by API routes (never by client
// components — those use src/lib/push-client.ts). Pulls in `web-push`, a
// Node-only library, so importing this into a client bundle would fail the
// build, which is the guard that keeps it server-side.
//
// Notifications are anonymous: we POST an encrypted payload to each browser's
// opaque push endpoint. No viewer identity is involved. Payload carries
// metadata only (channel name + media title + deep link) — never the source
// URL or any gated content, mirroring the RSS feed's no-leak discipline.
import * as webpush from "web-push";
import { prisma } from "@/lib/prisma";
import { getInstanceConfig } from "@/config/instance";

/**
 * Read the operator's VAPID config from env. Returns null (and the whole
 * feature no-ops) when any of the three vars is missing — this is how the
 * feature self-disables on instances that haven't generated keys. Read on every
 * call rather than memoized so env changes take effect immediately.
 */
function getVapidConfig(): {
  publicKey: string;
  privateKey: string;
  subject: string;
} | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

const DEFAULT_SEND_CONCURRENCY = 10;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * Positive-integer env override, else the default. Read per call so operators
 * can tune fan-out without a rebuild (and tests can shrink the timeout).
 */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Reject if `p` doesn't settle within `ms`. web-push exposes no abort handle, so
 * the underlying request is left to settle on its own — this only bounds how
 * long we wait, so a hung provider can't block a worker indefinitely.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`web-push send timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface NewContentNotification {
  channelId: string;
  channelSlug: string;
  channelName: string;
  /** App-relative (/api/images/...) or external URL; resolved to absolute. */
  channelImage?: string | null;
  media: { id: string; name: string };
}

/**
 * Fan out a "new content" notification to every browser that opted into push
 * for this channel. Best-effort: callers invoke this fire-and-forget after the
 * media-create transaction commits. Sends run with bounded concurrency (env
 * PUSH_SEND_CONCURRENCY, default 10) and a per-send timeout (env
 * PUSH_SEND_TIMEOUT_MS). Dead endpoints (404/410 Gone) are pruned; transient
 * failures (timeout/429/5xx/network) are logged and left for the next publish.
 */
export async function sendNewContentNotifications(
  n: NewContentNotification
): Promise<void> {
  const vapid = getVapidConfig();
  if (!vapid) return;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const subs = await prisma.pushSubscription.findMany({
    where: { channelId: n.channelId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return;

  const { domain } = await getInstanceConfig();
  const baseUrl = `https://${domain}`;
  const url = `${baseUrl}/c/${n.channelSlug}/${n.media.id}`;
  const icon = n.channelImage
    ? n.channelImage.startsWith("/")
      ? `${baseUrl}${n.channelImage}`
      : n.channelImage
    : undefined;

  const payload = JSON.stringify({
    title: n.channelName,
    body: `New: ${n.media.name}`,
    url,
    icon,
    // Collapse repeated pushes for the same channel into one notification.
    tag: n.channelSlug,
  });

  // Bounded worker pool: at most `concurrency` sends are in flight at once
  // (workers pull from a shared cursor), so a large subscriber list can't open
  // thousands of sockets at once or stall the publish path. 404/410 means the
  // browser dropped the subscription → prune it; anything else (timeout, 5xx,
  // network) is transient → log and leave for the next publish.
  const concurrency = envInt("PUSH_SEND_CONCURRENCY", DEFAULT_SEND_CONCURRENCY);
  const timeoutMs = envInt("PUSH_SEND_TIMEOUT_MS", DEFAULT_SEND_TIMEOUT_MS);
  const deadIds: string[] = [];
  let cursor = 0;

  async function drain(): Promise<void> {
    while (cursor < subs.length) {
      const s = subs[cursor];
      cursor += 1;
      try {
        await withTimeout(
          webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          ),
          timeoutMs
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number } | undefined)
          ?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deadIds.push(s.id);
        } else {
          console.error(
            "web-push send failed:",
            statusCode ?? (err as Error)?.message ?? err
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, subs.length) }, () => drain())
  );

  if (deadIds.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { id: { in: deadIds } },
    });
  }
}
