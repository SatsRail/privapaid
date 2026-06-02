// Client-side Web Push helpers. Kept separate from src/lib/push.ts (which pulls
// in the Node-only `web-push` library) so client components can import this
// without dragging server code into the browser bundle.

/**
 * Convert a base64url-encoded VAPID public key into the Uint8Array that
 * `PushManager.subscribe({ applicationServerKey })` requires. Standard Web Push
 * boilerplate.
 */
export function urlBase64ToUint8Array(
  base64String: string
): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Back the view with a concrete ArrayBuffer (not ArrayBufferLike) so it
  // satisfies the BufferSource that PushManager.subscribe expects.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
