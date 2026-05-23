"use client";

import { useEffect, useRef } from "react";

interface HeartbeatManagerProps {
  productId: string;
  onExpired: () => void;
  onKeyRefreshed: (key: string) => void;
  onRemainingSeconds?: (seconds: number) => void;
  intervalMs?: number;
}

export default function HeartbeatManager({
  productId,
  onExpired,
  onKeyRefreshed,
  onRemainingSeconds,
  intervalMs = 30000,
}: HeartbeatManagerProps) {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    async function heartbeat() {
      try {
        const res = await fetch("/api/macaroons", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: productId }),
        });

        if (res.ok) {
          const data = await res.json();
          onKeyRefreshed(data.key);
          if (data.remaining_seconds != null) {
            onRemainingSeconds?.(data.remaining_seconds);
          }
          return;
        }

        // 410 = portal definitively rejected the macaroon (access expired
        // or signature-invalid). The cookie has already been cleared by
        // the route; lock the content.
        // 404 = cookie has no entry for this product. Lock the content.
        // 502 / other non-2xx = transient portal failure (network blip,
        // upstream 5xx). The cookie is preserved by the route; do NOT
        // lock the user out for a temporary hiccup — retry on the next
        // interval. Treating these as expiry is what caused "image
        // disappears for a few minutes" after a single portal hiccup.
        if (res.status === 410 || res.status === 404) {
          onExpired();
        }
        // Any other status: leave content alone, retry next tick.
      } catch {
        // Network error — don't expire, just skip this check
      }
    }

    // Schedule periodic checks WITHOUT firing immediately. The caller has
    // already verified the macaroon (PaymentWall's mount-time access check
    // or the post-payment handler) before mounting us. An immediate-on-mount
    // heartbeat would race with a freshly-stored cookie and could silently
    // invalidate a customer's access if the portal hiccups for one tick —
    // exactly the "I paid but the image disappeared" failure mode.
    intervalRef.current = setInterval(heartbeat, intervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [productId, onExpired, onKeyRefreshed, onRemainingSeconds, intervalMs]);

  return null;
}
