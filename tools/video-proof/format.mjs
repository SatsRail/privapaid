// EXPERIMENTAL format: not imported by production PrivaPaid.
// Browser-safe helpers shared with the Node encryptor. No payment/key policy here.
export const MAGIC = new Uint8Array([80, 80, 86, 48]); // PPV0
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT = /^(?:play\.mpd|init-[0-9]{1,3}\.mp4|segment-[0-9]{1,3}-[0-9]{5,8}\.m4s)$/;
const encoder = new TextEncoder();

export function objectContext(asset, version, name) {
  if (typeof asset !== 'string' || typeof version !== 'string' || typeof name !== 'string' ||
      !UUID.test(asset) || !UUID.test(version) || !OBJECT.test(name)) {
    throw new Error('Invalid video object identity');
  }
  return encoder.encode(JSON.stringify(['privapaid-video-proof', 0, asset, version, name]));
}

export function versionSalt(version) {
  if (typeof version !== 'string' || !UUID.test(version)) throw new Error('Invalid video version');
  return encoder.encode(version);
}

export function checkBlob(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 33 || blob.length > MAX_OBJECT_BYTES + 32 ||
      !MAGIC.every((byte, i) => blob[i] === byte)) {
    throw new Error('Invalid encrypted video object');
  }
}

export async function importRoot(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('Invalid movie key');
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
}

export async function decryptObject(blob, root, asset, version, name) {
  checkBlob(blob);
  const context = objectContext(asset, version, name);
  const key = await crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: versionSalt(version), info: context,
  }, root, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  // No plaintext is returned until GCM authentication has succeeded.
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: blob.slice(4, 16), additionalData: context, tagLength: 128,
  }, key, blob.slice(16)));
}
