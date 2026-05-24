import { createHash } from "crypto";

/**
 * Check whether a password appears in the Have I Been Pwned breach
 * corpus, using the k-anonymity API.
 *
 * The client SHA-1s the password locally, sends only the first 5 hex
 * chars of the digest to api.pwnedpasswords.com, and scans the returned
 * suffix list for the remaining 35 chars. HIBP never sees the password
 * or its full hash — this is the standard privacy-preserving pattern.
 *
 * Returns:
 *   - `{ breached: true, count }` when the password appears in N breaches
 *   - `{ breached: false }` when it's clean
 *   - `{ breached: false, unavailable: true }` when HIBP is unreachable
 *
 * Why fail-open on HIBP unavailability: gating signup on a third-party
 * service's uptime is a worse outcome than admitting a known-weak
 * password. The password is still bcrypt-cost-12 hashed at rest and the
 * 10-character minimum still applies. Operators who want hard gating
 * can flip the `requireHibpReachable` toggle on the caller side.
 */

export interface BreachCheckResult {
  breached: boolean;
  count?: number;
  unavailable?: boolean;
}

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range";
const HIBP_TIMEOUT_MS = 3000;

function sha1HexUpper(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
}

export async function checkBreachedPassword(
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<BreachCheckResult> {
  const digest = sha1HexUpper(password);
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);

  let body: string;
  try {
    const res = await fetchImpl(`${HIBP_RANGE_URL}/${prefix}`, {
      signal: controller.signal,
      // HIBP recommends this header to opt out of returning padded results.
      // We send it because callers might want exact counts later, and a
      // padded response makes the count untrustworthy.
      headers: { "Add-Padding": "false" },
    });
    if (!res.ok) {
      return { breached: false, unavailable: true };
    }
    body = await res.text();
  } catch {
    return { breached: false, unavailable: true };
  } finally {
    clearTimeout(timer);
  }

  // Response format: lines of `SUFFIX:COUNT`. Suffixes are uppercase hex.
  // Linear scan is fine — responses cap around ~800 entries.
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const lineSuffix = line.slice(0, sep).trim().toUpperCase();
    if (lineSuffix === suffix) {
      const count = parseInt(line.slice(sep + 1).trim(), 10);
      return { breached: true, count: Number.isFinite(count) ? count : 1 };
    }
  }

  return { breached: false };
}
