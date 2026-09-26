// JSON-only contract shared with the browser. No server or storage imports.
export type DeliveryCookies = {
  "CloudFront-Policy": string;
  "CloudFront-Signature": string;
  "CloudFront-Key-Pair-Id": string;
  "CloudFront-Hash-Algorithm": "SHA256";
};
export type PlaybackSession = {
  format: 1;
  asset: string;
  version: string;
  attempt: string;
  prefix: string;
  objectBase: string;
  grantUrl: string;
  grant: DeliveryCookies;
  serverTime: number;
  expiresAt: number;
  encryptedDescriptor: string;
  key: string;
  key_fingerprint: string;
  product_id: string;
  encrypted_blob: string;
  remaining_seconds: number;
};
export const OUTPUT_NAME = /^(?:play\.mpd|catalog\.json|init-\d{1,3}\.mp4|segment-\d{1,3}-\d{5,8}\.m4s)$/;
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_CIPHER_BYTES = 32 * 1024 * 1024 + 32;
