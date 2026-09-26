import { verify } from "node:crypto";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import type { DeliveryConfig } from "./delivery-config";
import { UUID, type DeliveryCookies } from "./playback-contract";

export class PlaybackError extends Error {
  constructor(public code: string, public status = 503, public retryAfter = 5) { super(code); }
}
export function attemptPrefix(asset: string, version: string, attempt: string) {
  if (![asset, version, attempt].every(id => UUID.test(id))) throw new PlaybackError("VIDEO_NOT_READY", 404);
  return `assets/${asset}/versions/${version}/attempts/${attempt}`;
}
export function issueGrant(config: DeliveryConfig, prefix: string, expiresAt: number): DeliveryCookies {
  const policy = JSON.stringify({ Statement: [{ Resource: `${config.objectBase}${prefix}/*`,
    Condition: { DateLessThan: { "AWS:EpochTime": Math.floor(expiresAt / 1000) } } }] });
  return getSignedCookies({ policy, keyPairId: config.keyPairId, privateKey: config.privateKey, algorithm: "SHA256" }) as DeliveryCookies;
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_~-]+$/.test(value)) throw new Error();
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");
}
export function checkGrant(config: DeliveryConfig, input: unknown, now = Date.now()) {
  try {
    const grant = input as DeliveryCookies;
    if (!grant || Object.keys(grant).length !== 4 || grant["CloudFront-Key-Pair-Id"] !== config.keyPairId || grant["CloudFront-Hash-Algorithm"] !== "SHA256" ||
        typeof grant["CloudFront-Policy"] !== "string" || grant["CloudFront-Policy"].length > 2048 ||
        typeof grant["CloudFront-Signature"] !== "string" || grant["CloudFront-Signature"].length > 512) throw new Error();
    const raw = decode(grant["CloudFront-Policy"]);
    if (!verify("RSA-SHA256", raw, config.publicKey, decode(grant["CloudFront-Signature"]))) throw new Error();
    const policy = JSON.parse(raw.toString("utf8")), statement = policy.Statement?.[0];
    const resource: string = statement?.Resource;
    const expiry: number = statement?.Condition?.DateLessThan?.["AWS:EpochTime"];
    if (policy.Statement.length !== 1 || !Number.isSafeInteger(expiry) || expiry * 1000 <= now || expiry * 1000 > now + config.ttlSeconds * 1000 ||
        typeof resource !== "string" || !resource.startsWith(config.objectBase) || !resource.endsWith("/*")) throw new Error();
    const prefix = resource.slice(config.objectBase.length, -2);
    const parts = prefix.split("/");
    if (prefix !== attemptPrefix(parts[1], parts[3], parts[5])) throw new Error();
    // Reject alternative conditions/wildcards, including a valid signature over
    // an unexpected policy. This endpoint only installs our narrow grants.
    if (raw.toString("utf8") !== JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { "AWS:EpochTime": expiry } } }] })) throw new Error();
    return { prefix, path: new URL(`${config.objectBase}${prefix}/`).pathname, expiresAt: expiry * 1000, grant };
  } catch { throw new PlaybackError("DELIVERY_DENIED", 403); }
}
