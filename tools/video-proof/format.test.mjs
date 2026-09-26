import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, webcrypto, createCipheriv } from 'node:crypto';
import { decryptObject, importRoot, objectContext, MAX_OBJECT_BYTES } from './format.mjs';
import { encryptObject } from './encrypt.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const asset = '11111111-1111-4111-8111-111111111111';
const version = '22222222-2222-4222-8222-222222222222';
const name = 'segment-0-00001.m4s';
const raw = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const plain = new TextEncoder().encode('synthetic fragment bytes');
const root = await importRoot(raw);

test('Node encryption interoperates with Web Crypto for manifest, init, audio and video', async () => {
  for (const file of ['play.mpd', 'init-0.mp4', name, 'segment-1-00001.m4s']) {
    const encrypted = encryptObject(plain, raw, asset, version, file);
    assert.deepEqual(await decryptObject(encrypted, root, asset, version, file), plain);
  }
  assert.equal(root.extractable, false);
});

test('published HKDF vector independently fixes the KDF behavior (RFC 5869 case 1)', async () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const key = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const out = await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
    salt: Buffer.from('000102030405060708090a0b0c', 'hex'),
    info: Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex') }, key, 336);
  assert.equal(Buffer.from(out).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('fixed context encoding prevents ambiguous identity concatenation', () => {
  assert.equal(new TextDecoder().decode(objectContext(asset, version, name)),
    `["privapaid-video-proof",0,"${asset}","${version}","${name}"]`);
});

test('wrong key, asset, version, track and sequence reject before returning plaintext', async () => {
  const blob = encryptObject(plain, raw, asset, version, name);
  const wrong = await importRoot(randomBytes(32));
  for (const args of [
    [wrong, asset, version, name], [root, randomUUID(), version, name],
    [root, asset, randomUUID(), name], [root, asset, version, 'segment-1-00001.m4s'],
    [root, asset, version, 'segment-0-00002.m4s'], [root, asset, version, 'play.mpd'],
  ]) await assert.rejects(decryptObject(blob, ...args));
});

test('every corrupted byte, truncated object and trailing bytes reject', async () => {
  const blob = encryptObject(plain, raw, asset, version, name);
  for (let i = 0; i < blob.length; i++) {
    const changed = Uint8Array.from(blob); changed[i] ^= 1;
    await assert.rejects(decryptObject(changed, root, asset, version, name));
  }
  for (let n = 0; n < blob.length; n++) {
    await assert.rejects(decryptObject(blob.slice(0, n), root, asset, version, name));
  }
  await assert.rejects(decryptObject(Buffer.concat([blob, Buffer.from([0])]), root, asset, version, name));
});

test('manifest substitution and initialization substitution reject', async () => {
  const blob = encryptObject(plain, raw, asset, version, 'play.mpd');
  await assert.rejects(decryptObject(blob, root, asset, version, 'init-0.mp4'));
  await assert.rejects(decryptObject(blob, root, asset, randomUUID(), 'play.mpd'));
});

test('retry encryption uses a fresh IV and new version produces distinct object keys', async () => {
  const a = encryptObject(plain, raw, asset, version, name);
  const b = encryptObject(plain, raw, asset, version, name);
  assert.notDeepEqual(a.subarray(4, 16), b.subarray(4, 16));
  const next = encryptObject(plain, raw, asset, randomUUID(), name);
  await assert.rejects(decryptObject(next, root, asset, version, name));
});

test('reject malformed identities, paths, unsupported versions and size/key errors', async () => {
  for (const file of ['../play.mpd', 'https://example.org/a', 'init-0.mp4?x', 'segment-0-1.m4s', 'x', 'play.mpd\n']) {
    assert.throws(() => encryptObject(plain, raw, asset, version, file));
  }
  assert.throws(() => encryptObject(plain, raw, '../x', version, name));
  assert.throws(() => encryptObject(plain, raw, [asset], version, name));
  assert.throws(() => encryptObject(plain, raw, asset, version, ['play.mpd']));
  assert.throws(() => encryptObject(new Uint8Array(), raw, asset, version, name));
  assert.throws(() => encryptObject(new Uint8Array(MAX_OBJECT_BYTES + 1), raw, asset, version, name));
  await assert.rejects(importRoot(new Uint8Array(16)));
});

test('independent AES-256-GCM known answer (all-zero key, IV and one block)', async () => {
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
  const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()]);
  assert.equal(ciphertext.toString('hex'), 'cea7403d4d606b6e074ec5d3baf39d18');
  assert.equal(cipher.getAuthTag().toString('hex'), 'd0d1c8a799996bf0265b98b5d48ab919');
});

test('a generation retry refuses existing output without changing its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'privapaid-video-immutable-'));
  try {
    const sentinel = join(dir, 'sentinel');
    await writeFile(sentinel, 'existing published bytes');
    await assert.rejects(promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./generate.mjs', import.meta.url)), '--output', dir]),
    error => error.code === 1 && error.stderr.includes('EEXIST'));
    assert.equal(await readFile(sentinel, 'utf8'), 'existing published bytes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
