import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { setupTestDB, clearCollections, teardownTestDB } from '../../helpers/postgres';
import { createChannel, createMedia } from '../../helpers/factories';
import { prisma } from '@/lib/prisma';
import { schemas } from '@/lib/validate';
import { decryptEnvelopePayload } from '@/lib/media-envelope';
import { clientDecryptBlob, clientDecryptBytesWithKey } from '../../helpers/crypto';
const cookieState = vi.hoisted(() => ({ value: '' }));
vi.mock('next/headers', () => ({ cookies: vi.fn().mockImplementation(async () => ({ get: () => ({ value: cookieState.value }) })), headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));

vi.mock('@/lib/auth', () => ({ auth: vi.fn().mockResolvedValue({ user: { id: 'audit', email: 'audit@example.test', type: 'admin', role: 'owner' } }) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/merchant-key', () => ({ getMerchantKey: vi.fn().mockResolvedValue('sk_test_audit') }));
vi.mock('@/lib/satsrail', () => ({ satsrail: {
  listProductTypes: vi.fn().mockResolvedValue({ data: [] }),
  createProductType: vi.fn().mockImplementation(async () => ({ id: crypto.randomUUID() })),
  listProducts: vi.fn().mockResolvedValue({ data: [] }),
  createProduct: vi.fn().mockImplementation(async () => ({ id: crypto.randomUUID() })),
  updateProduct: vi.fn().mockResolvedValue({}),
  getProduct: vi.fn().mockResolvedValue({ old_key: null }),
  getProductKey: vi.fn().mockResolvedValue({ key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', key_fingerprint: 'audit' }),
} }));
import { ApiThrottle } from '@/lib/import-helpers';
import { POST as importAll } from '@/app/api/admin/import/route';
import { POST as importChannel } from '@/app/api/admin/channels/[id]/import/route';
import { GET as exportAll } from '@/app/api/admin/export/route';
import { getMerchantKey } from '@/lib/merchant-key';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function request(body: unknown) { return new NextRequest('http://localhost/api/admin/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function complete(response: Response) {
  const raw = await response.text();
  const match = raw.match(/event: complete\ndata: ([^\n]+)/);
  if (!match) throw new Error(raw);
  return JSON.parse(match[1]);
}
describe('Import safety regressions', () => {
  beforeAll(async () => { await setupTestDB(); vi.spyOn(ApiThrottle.prototype, 'throttle').mockResolvedValue(); });
  beforeEach(async () => { await clearCollections(); vi.mocked(getMerchantKey).mockResolvedValue('sk_test_audit'); });
  afterAll(async () => { await teardownTestDB(); await prisma.$disconnect(); });

  it('records validation of every checked-in demo and public import sample', () => {
    for (const file of ['public/import-sample.json','public/channel-import-sample.json','public/channel-sampler.json']) {
      const data = JSON.parse(readFileSync(`${root}/${file}`, 'utf8'));
      const result = (data.media ? schemas.channelImportPayload : schemas.importPayload).safeParse(data);
      console.log('FIXTURE', file, result.success ? 'valid' : JSON.stringify(result.error.issues));
      expect(result.success).toBe(true);
    }
  });

  it('channel import adds decryptable coverage to an existing channel pass and retries safely', async () => {
    const ch = await createChannel({ satsrailProductTypeId: randomUUID() });
    const pass = await prisma.product.create({ data: { channelId: ch.id, satsrailProductId: randomUUID(), productName: 'All access', productPriceCents: 100 } });
    const result = await complete(await importChannel(request({ version: '1.0', media: [{ name: 'New episode', source_url: 'https://example.test/new.mp4' }] }), { params: Promise.resolve({ id: ch.id }) }));
    expect(result.success).toBe(true);
    expect(await prisma.media.count()).toBe(1);
    expect(await prisma.mediaProduct.count({ where: { productId: pass.id } })).toBe(1);
    const media = await prisma.media.findFirstOrThrow({ include: { envelope: true, mediaProducts: true } });
    const dek = await clientDecryptBlob(media.mediaProducts[0].encryptedDek, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', pass.satsrailProductId);
    const payload = await clientDecryptBytesWithKey(media.envelope!.bytes, Uint8Array.from(Buffer.from(new TextDecoder().decode(dek), 'base64url')));
    expect(new TextDecoder().decode(payload)).toBe('https://example.test/new.mp4');
    const retry = await complete(await importChannel(request({ version: '1.0', media: [{ name: 'New episode', source_url: 'https://example.test/new.mp4' }] }), { params: Promise.resolve({ id: ch.id }) }));
    expect(retry.success).toBe(true);
    expect(await prisma.media.count()).toBe(1);
    expect(await prisma.mediaProduct.count()).toBe(1);
  });

  it('rejects photo JSON before any writes and preserves existing image bytes', async () => {
    const ch = await createChannel({ satsrailProductTypeId: randomUUID() });
    const media = await createMedia(ch.id, { mediaType: 'photo', sourceUrl: 'original-photo-payload' });
    const exported = await (await exportAll()).json();
    const response = await importAll(request(exported));
    expect(response.status).toBe(400);
    const env = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId: media.id } });
    expect(decryptEnvelopePayload(env).toString()).toBe('original-photo-payload');
  });

  it('cannot overwrite an existing photo by omitting the media type', async () => {
    const ch = await createChannel();
    const media = await createMedia(ch.id, { mediaType: 'photo', sourceUrl: 'original-photo-payload' });
    const before = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId: media.id } });
    const result = await complete(await importChannel(request({ version: '1.0', media: [{ ref: media.ref, name: media.name, source_url: 'replacement' }] }), { params: Promise.resolve({ id: ch.id }) }));
    expect(result.success).toBe(false);
    const after = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId: media.id } });
    expect(after.bytes).toEqual(before.bytes);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: media.id } })).mediaType).toBe('photo');
  });

  it('refuses pass linking during pending rotation and repairs it on retry', async () => {
    const { satsrail } = await import('@/lib/satsrail');
    const ch = await createChannel();
    const pass = await prisma.product.create({ data: { channelId: ch.id, satsrailProductId: randomUUID() } });
    vi.mocked(satsrail.getProduct).mockResolvedValueOnce({ old_key: 'pending' } as Awaited<ReturnType<typeof satsrail.getProduct>>);
    const payload = { version: '1.0', media: [{ name: 'Rotation test', source_url: 'https://example.test/movie.mp4' }] };
    const ctx = { params: Promise.resolve({ id: ch.id }) };
    const first = await complete(await importChannel(request(payload), ctx));
    expect(first.success).toBe(false);
    expect(await prisma.mediaProduct.count()).toBe(0);
    const retry = await complete(await importChannel(request(payload), ctx));
    expect(retry.success).toBe(true);
    expect(await prisma.media.count()).toBe(1);
    expect(await prisma.mediaProduct.count({ where: { productId: pass.id } })).toBe(1);
  });

  it('advances the sequence after explicit refs, including subsequent ordinary inserts', async () => {
    const ch = await createChannel({ satsrailProductTypeId: randomUUID() });
    const ctx = { params: Promise.resolve({ id: ch.id }) };
    const first = await complete(await importChannel(request({ version: '1.0', media: [{ ref: 1, name: 'Restored', source_url: 'https://example.test/old.mp4' }] }), ctx));
    expect(first.success).toBe(true);
    const second = await complete(await importChannel(request({ version: '1.0', media: [{ name: 'Next upload', source_url: 'https://example.test/new.mp4' }] }), ctx));
    expect(second.success).toBe(true);
    const ordinary = await createMedia(ch.id);
    expect(ordinary.ref).toBeGreaterThan(1);
    expect(await prisma.media.count()).toBe(3);
  });

  it('exports lifetime products in importable form and accepts legacy null duration', async () => {
    const ch = await createChannel();
    const media = await createMedia(ch.id);
    await prisma.product.create({ data: { mediaId: media.id, satsrailProductId: randomUUID(), productName: 'Lifetime', productPriceCents: 100, productAccessDurationSeconds: null } });
    const exported = await (await exportAll()).json();
    const parsed = schemas.importPayload.safeParse(exported);
    expect(parsed.success).toBe(true);
    exported.channels[0].media[0].product.access_duration_seconds = null;
    expect(schemas.importPayload.safeParse(exported).success).toBe(true);
  });

  it('creates a product type for a channel-only pass on an existing channel', async () => {
    const ch = await createChannel({ slug: 'existing', satsrailProductTypeId: null });
    const result = await complete(await importAll(request({ version: '1.0', channels: [{ slug: ch.slug, name: ch.name, product: { name: 'Pass', price_cents: 100 }, media: [{ name: 'Episode', source_url: 'https://example.test/episode.mp4' }] }] })));
    expect(result.success).toBe(true);
    expect(await prisma.product.count()).toBe(1);
  });

  it('rejects paid imports without credentials before writing content', async () => {
    vi.mocked(getMerchantKey).mockResolvedValue(null);
    const response = await importAll(request({ version: '1.0', channels: [{ slug: 'paid', name: 'Paid', media: [{ name: 'Episode', source_url: 'https://example.test/episode.mp4', product: { name: 'Buy', price_cents: 100 } }] }] }));
    expect(response.status).toBe(422);
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.media.count()).toBe(0);
    expect(await prisma.channel.count()).toBe(0);
  });

  it('scrubs content URLs from renderer exceptions and extras', async () => {
    const { scrubEvent } = await import('@/lib/sentry-scrub');
    const url = 'https://private.example.test/paid.mp4?token=paid-secret';
    const result = scrubEvent({ type: undefined, exception: { values: [{ type: 'Error', value: `Video element failed to load: ${url}` }] }, extra: { mediaType: 'video', url } });
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it('rejects a valid purchase token for A filed under B without flagging B as broken', async () => {
    const { POST: reportError } = await import('@/app/api/media/[id]/report-error/route');
    const { encryptSourceUrl } = await import('@/lib/content-encryption');
    const { dekBase64urlFromEnvelope } = await import('@/lib/media-envelope');
    const ch = await createChannel();
    const media = await createMedia(ch.id);
    const env = await prisma.mediaEnvelope.findUniqueOrThrow({ where: { mediaId: media.id } });
    const productB = randomUUID();
    const keyB = Buffer.alloc(32, 1).toString('base64url');
    await prisma.product.create({ data: { mediaId: media.id, satsrailProductId: productB, mediaProducts: { create: { mediaId: media.id, encryptedDek: encryptSourceUrl(dekBase64urlFromEnvelope(env), keyB, productB) } } } });
    cookieState.value = JSON.stringify({ [productB]: { m: 'valid-token-for-different-product-A', t: Date.now() } });
    // Simulates the real portal verifying A and returning A's key. No signature forgery.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ valid: true, product_id: randomUUID(), remaining_seconds: 3600, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })));
    try {
      const res = await reportError(new Request('http://localhost/api/media/report-error', { method: 'POST', body: JSON.stringify({ reason: 'integrity_auth_failed' }) }), { params: Promise.resolve({ id: media.id }) });
      expect(res.status).toBe(401);
      expect((await prisma.media.findUniqueOrThrow({ where: { id: media.id } })).status).not.toBe('error');
      expect(decryptEnvelopePayload(env).toString()).toBe('https://example.com/video.mp4');
    } finally { vi.unstubAllGlobals(); cookieState.value = ''; }
  });
});
