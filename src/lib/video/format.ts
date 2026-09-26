import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { MAX_OBJECT_BYTES } from "./ingestion-config";
import { IngestionError } from "./ingestion-errors";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type ObjectIdentity = { asset: string; version: string; attempt: string; name: string };
export function context(identity: ObjectIdentity) {
  if (![identity.asset, identity.version, identity.attempt].every(v => uuidPattern.test(v)) ||
      !/^(?:play\.mpd|catalog\.json|init-\d{1,3}\.mp4|segment-\d{1,3}-\d{5,8}\.m4s|source-\d{6}\.bin)$/.test(identity.name)) throw new IngestionError("OUTPUT_INVALID");
  return Buffer.from(JSON.stringify(["privapaid-video", 1, identity.asset, identity.version, identity.attempt, identity.name]));
}
function keyFor(root: Buffer, identity: ObjectIdentity) {
  if (root.length !== 32) throw new IngestionError("KEY_STATE_CHANGED");
  return Buffer.from(hkdfSync("sha256", root, Buffer.from(identity.version), context(identity), 32));
}
export function sealObject(root: Buffer, identity: ObjectIdentity, plaintext: Buffer): Buffer {
  if (!plaintext.length || plaintext.length > MAX_OBJECT_BYTES) throw new IngestionError("OUTPUT_INVALID");
  const key = keyFor(root, identity), iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(context(identity));
    return Buffer.concat([Buffer.from("PPV1"), iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}
export function openObject(root: Buffer, identity: ObjectIdentity, ciphertext: Buffer): Buffer {
  if (ciphertext.length < 33 || ciphertext.length > MAX_OBJECT_BYTES + 32 || ciphertext.toString("ascii", 0, 4) !== "PPV1") throw new IngestionError("OUTPUT_INVALID");
  const key = keyFor(root, identity);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(4, 16));
    decipher.setAAD(context(identity)); decipher.setAuthTag(ciphertext.subarray(-16));
    const pending = decipher.update(ciphertext.subarray(16, -16));
    try { return Buffer.concat([pending, decipher.final()]); }
    finally { pending.fill(0); }
  } catch { throw new IngestionError("OUTPUT_INVALID"); }
  finally { key.fill(0); }
}
export function encryptDescriptor(mediaKey: Buffer, asset: string, version: string, value: object): Buffer {
  const plain = Buffer.from(JSON.stringify(value)), iv = randomBytes(12);
  if (plain.length > 16000) throw new IngestionError("OUTPUT_INVALID");
  try {
    const cipher = createCipheriv("aes-256-gcm", mediaKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(["privapaid-video-descriptor", 1, asset, version])));
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  } finally { plain.fill(0); }
}
export function sourceName(index: number) { return `source-${String(index).padStart(6, "0")}.bin`; }
