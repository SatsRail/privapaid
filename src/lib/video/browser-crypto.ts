import { HASH, MAX_CIPHER_BYTES, OUTPUT_NAME, UUID, type PlaybackSession } from "./playback-contract";
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });
export type Descriptor = { format: 1; asset: string; version: string; attempt: string; prefix: string;
  manifest: { name: "play.mpd"; sha256: string }; catalog: { name: "catalog.json"; sha256: string } };
export type CatalogEntry = { name: string; bytes: number; encryptedBytes: number; sha256: string; encryptedSha256: string };
export function decode64(value: string, limit = MAX_CIPHER_BYTES): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(limit * 4 / 3) + 4 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error("VIDEO_INTEGRITY");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
export async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}
async function unwrap(raw: Uint8Array<ArrayBuffer>, keyBytes: Uint8Array<ArrayBuffer>, aad: string) {
  try {
    if (keyBytes.length !== 32 || raw.length < 29) throw new Error();
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: utf8.encode(aad) }, key, raw.subarray(12)));
  } catch { throw new Error("VIDEO_INTEGRITY"); }
  finally { keyBytes.fill(0); raw.fill(0); }
}
export async function openDescriptor(session: PlaybackSession): Promise<{ descriptor: Descriptor; root: CryptoKey }> {
  if (session.format !== 1 || ![session.asset, session.version, session.attempt].every(v => UUID.test(v)) ||
      !HASH.test(session.key_fingerprint) || await digest(utf8.encode(session.key)) !== session.key_fingerprint) throw new Error("VIDEO_INTEGRITY");
  const encodedDek = await unwrap(decode64(session.encrypted_blob, 512), decode64(session.key, 32), session.product_id);
  let plain: Uint8Array<ArrayBuffer> | undefined, rootBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    plain = await unwrap(decode64(session.encryptedDescriptor, 16384), decode64(text.decode(encodedDek), 32),
      JSON.stringify(["privapaid-video-descriptor", 1, session.asset, session.version]));
    const parsed = JSON.parse(text.decode(plain));
    const prefix = `assets/${session.asset}/versions/${session.version}/attempts/${session.attempt}`;
    if (parsed.format !== 1 || parsed.asset !== session.asset || parsed.version !== session.version || parsed.attempt !== session.attempt ||
        parsed.prefix !== prefix || session.prefix !== prefix || parsed.manifest?.name !== "play.mpd" || parsed.catalog?.name !== "catalog.json" ||
        !HASH.test(parsed.manifest.sha256) || !HASH.test(parsed.catalog.sha256)) throw new Error("VIDEO_INTEGRITY");
    rootBytes = decode64(parsed.rootKey, 32);
    if (rootBytes.length !== 32) throw new Error("VIDEO_INTEGRITY");
    const root = await crypto.subtle.importKey("raw", rootBytes, "HKDF", false, ["deriveKey"]);
    delete parsed.rootKey;
    return { descriptor: parsed, root };
  } finally { encodedDek.fill(0); plain?.fill(0); rootBytes?.fill(0); }
}
export async function decryptObject(root: CryptoKey, descriptor: Descriptor, name: string, wire: Uint8Array<ArrayBuffer>, expectedHash: string) {
  try {
    if (!OUTPUT_NAME.test(name) || wire.length < 33 || wire.length > MAX_CIPHER_BYTES ||
        text.decode(wire.subarray(0, 4)) !== "PPV1" || !HASH.test(expectedHash) || await digest(wire) !== expectedHash) throw new Error();
    const aad = utf8.encode(JSON.stringify(["privapaid-video", 1, descriptor.asset, descriptor.version, descriptor.attempt, name]));
    const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode(descriptor.version), info: aad }, root,
      { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wire.subarray(4, 16), additionalData: aad }, key, wire.subarray(16)));
  } catch { throw new Error("VIDEO_INTEGRITY"); }
  finally { wire.fill(0); }
}
export function readCatalog(plain: Uint8Array<ArrayBuffer>, descriptor: Descriptor): Map<string, CatalogEntry> {
  try {
    const data = JSON.parse(text.decode(plain));
    if (data.format !== 1 || data.asset !== descriptor.asset || data.version !== descriptor.version || data.attempt !== descriptor.attempt ||
        !Array.isArray(data.objects) || data.objects.length < 2 || data.objects.length > 15000) throw new Error();
    const entries = new Map<string, CatalogEntry>();
    for (const e of data.objects) {
      if (!OUTPUT_NAME.test(e.name) || e.name === "catalog.json" || entries.has(e.name) ||
          !Number.isSafeInteger(e.bytes) || e.bytes < 1 || e.bytes > MAX_CIPHER_BYTES - 32 || e.encryptedBytes !== e.bytes + 32 ||
          !HASH.test(e.sha256) || !HASH.test(e.encryptedSha256)) throw new Error();
      entries.set(e.name, e);
    }
    if (entries.get("play.mpd")?.encryptedSha256 !== descriptor.manifest.sha256) throw new Error();
    return entries;
  } catch { throw new Error("VIDEO_INTEGRITY"); }
  finally { plain.fill(0); }
}
export function validateManifest(plain: Uint8Array<ArrayBuffer>) {
  // The packager emits a fixed static DASH subset. Do not allow a signed movie
  // to make the player contact arbitrary origins, licensing or timing servers.
  const xml = text.decode(plain);
  if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|xlink:|<\s*(?:BaseURL|Location|UTCTiming|ContentProtection|PatchLocation|ContentSteering)\b/i.test(xml)) throw new Error("VIDEO_INTEGRITY");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "MPD" || doc.documentElement.getAttribute("type") !== "static") throw new Error("VIDEO_INTEGRITY");
  for (const template of doc.querySelectorAll("SegmentTemplate")) {
    if (template.getAttribute("initialization") !== "init-$RepresentationID$.mp4" ||
        template.getAttribute("media") !== "segment-$RepresentationID$-$Number%05d$.m4s") throw new Error("VIDEO_INTEGRITY");
  }
}
