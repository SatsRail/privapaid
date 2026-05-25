import type { ErrorEvent, EventHint, Breadcrumb } from "@sentry/nextjs";

/**
 * Keys whose values must never reach Sentry. Matched case-insensitively
 * against full key names. Also matched against name prefixes like `sk_`
 * and `pk_` to catch SatsRail token shapes regardless of where they
 * appear in the payload.
 *
 * Why this exists: Sentry's default `request.data` capture serializes
 * request bodies. Admin media-create posts carry plaintext `source_url`,
 * setup posts carry a live `satsrail_api_key`, and customer signups
 * carry a plaintext `password`. Without scrubbing these would land in
 * the Sentry UI in plaintext.
 */
const SENSITIVE_KEYS = new Set(
  [
    "source_url",
    "password",
    "password_hash",
    "satsrail_api_key",
    "satsrail_api_key_encrypted",
    "macaroon",
    "authorization",
    "cookie",
    "set-cookie",
    "dek",
    "encrypted_dek",
    "encrypteddek",
    "master_key",
    "encryption_key",
    "sk_encryption_key",
    "admin_source_url_plaintext",
    "admin_source_plaintext",
    "admin_photo_bytes",
    // Media.blob (JSONB) carries the type-discriminated plaintext payload
    // (URL for video/audio/podcast, markdown body for article, wrapped DEK
    // for photo). Treat the whole field as sensitive at the top level —
    // scrubInPlace stops recursing into a key once it matches, so the
    // entire JSON payload is replaced with the scrub marker.
    "blob",
  ].map((k) => k.toLowerCase())
);

const SENSITIVE_PREFIXES = ["sk_", "pk_"];

const SCRUB_MARKER = "[scrubbed]";
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  for (const prefix of SENSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function scrubValue(value: unknown): string {
  if (typeof value === "string") return `${SCRUB_MARKER}:${value.length}`;
  if (value === null || value === undefined) return SCRUB_MARKER;
  try {
    return `${SCRUB_MARKER}:${JSON.stringify(value).length}`;
  } catch {
    return SCRUB_MARKER;
  }
}

function scrubInPlace(node: unknown, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) scrubInPlace(item, depth + 1);
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (isSensitiveKey(key)) {
      obj[key] = scrubValue(obj[key]);
    } else {
      scrubInPlace(obj[key], depth + 1);
    }
  }
}

/**
 * Sentry `beforeSend` hook. Mutates the event in place to redact any
 * sensitive values before transmission. Returns the event so the
 * Sentry SDK can transmit it.
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  if (event.request) {
    if (event.request.data) scrubInPlace(event.request.data, 0);
    if (event.request.headers) scrubInPlace(event.request.headers, 0);
    if (event.request.cookies) scrubInPlace(event.request.cookies, 0);
    if (event.request.query_string) {
      // Drop the query string entirely — too risky to parse and selectively
      // scrub query params that could contain tokens.
      event.request.query_string = SCRUB_MARKER;
    }
  }
  if (event.extra) scrubInPlace(event.extra, 0);
  if (event.contexts) scrubInPlace(event.contexts, 0);
  if (event.tags) scrubInPlace(event.tags, 0);
  if (event.user) scrubInPlace(event.user, 0);
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data) scrubInPlace(crumb.data, 0);
    }
  }
  return event;
}

/**
 * Sentry `beforeBreadcrumb` hook. Scrubs the breadcrumb's `data` field
 * before it joins the event's breadcrumb trail. Returns the breadcrumb
 * (Sentry drops it if null is returned, which we don't want — we want
 * the breadcrumb, just without the plaintext).
 */
export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  _hint?: EventHint
): Breadcrumb {
  if (breadcrumb.data) scrubInPlace(breadcrumb.data, 0);
  return breadcrumb;
}

// Exported for tests only.
export const __test__ = { isSensitiveKey, scrubValue, scrubInPlace, SCRUB_MARKER };
