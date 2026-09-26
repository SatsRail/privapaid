import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { MAGIC, MAX_OBJECT_BYTES, objectContext, versionSalt } from './format.mjs';

export function encryptObject(plaintext, root, asset, version, name) {
  if (!(plaintext instanceof Uint8Array) || !plaintext.length || plaintext.length > MAX_OBJECT_BYTES) {
    throw new Error('Invalid plaintext size');
  }
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('Invalid movie key');
  const context = objectContext(asset, version, name);
  const key = Buffer.from(hkdfSync('sha256', root, versionSalt(version), context, 32));
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context);
    return Buffer.concat([MAGIC, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

// PUBLIC synthetic fixture key. Never use for customer media; generation accepts
// only a built-in test pattern, not a file or URL. It is deliberately reproducible
// from public metadata, so no production key or persisted raw secret is needed.
export function publicFixtureKey(version) {
  versionSalt(version);
  return createHash('sha256').update(`privapaid-public-synthetic-fixture-v0:${version}`).digest();
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
