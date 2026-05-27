import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { findMediaProducts } from "../../helpers/factories";
import { createCategory, createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

function generateProductKey(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Mock auth
const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// Mock satsrail client
const mockCreateProductType = vi.fn();
const mockListProductTypes = vi.fn().mockResolvedValue({ data: [] });
const mockCreateProduct = vi.fn();
const mockListProducts = vi.fn().mockResolvedValue({ data: [] });
const mockGetProductKey = vi.fn();
const mockUpdateProduct = vi.fn();

vi.mock("@/lib/satsrail", () => ({
  satsrail: {
    createProductType: (...args: unknown[]) => mockCreateProductType(...args),
    listProductTypes: (...args: unknown[]) => mockListProductTypes(...args),
    createProduct: (...args: unknown[]) => mockCreateProduct(...args),
    listProducts: (...args: unknown[]) => mockListProducts(...args),
    getProductKey: (...args: unknown[]) => mockGetProductKey(...args),
    updateProduct: (...args: unknown[]) => mockUpdateProduct(...args),
  },
}));

// Mock getMerchantKey
vi.mock("@/lib/merchant-key", () => ({
  getMerchantKey: vi.fn().mockResolvedValue("sk_live_test_key"),
}));

// Mock audit
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

// Mock next/headers for audit
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(""),
  }),
}));

import { POST } from "@/app/api/admin/import/route";

function importRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/admin/import"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readSSEResult(res: Response): Promise<{ success: boolean; results: Record<string, unknown> }> {
  const text = await res.text();
  const lines = text.split("\n");
  let eventType = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7);
    } else if (line.startsWith("data: ") && eventType === "complete") {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error("No complete event found in SSE stream");
}

describe("POST /api/admin/import", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(importRequest({ version: "1.0" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload (missing version)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const res = await POST(importRequest({ categories: [] }));
    expect(res.status).toBe(400);
  });

  it("creates new categories", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        categories: [
          { slug: "movies", name: "Movies", position: 1, active: true },
          { slug: "music", name: "Music", position: 2 },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.categories as { created: number }).created).toBe(2);
    expect((body.results.categories as { updated: number }).updated).toBe(0);

    const cats = await prisma.category.findMany({ orderBy: { position: "asc" } });
    expect(cats).toHaveLength(2);
    expect(cats[0].slug).toBe("movies");
    expect(cats[1].slug).toBe("music");
  });

  it("updates existing categories by slug", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    await createCategory({ name: "Old Name", slug: "movies", position: 1 });

    const res = await POST(
      importRequest({
        version: "1.0",
        categories: [{ slug: "movies", name: "New Name", position: 5 }],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.categories as { created: number }).created).toBe(0);
    expect((body.results.categories as { updated: number }).updated).toBe(1);

    const cat = await prisma.category.findFirst({ where: { slug: "movies" } });
    expect(cat!.name).toBe("New Name");
    expect(cat!.position).toBe(5);
  });

  it("creates new channels with SatsRail product types", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_123" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "bitcoin-101",
            name: "Bitcoin 101",
            bio: "Learn Bitcoin",
            active: true,
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);

    const ch = await prisma.channel.findFirst({ where: { slug: "bitcoin-101" } });
    expect(ch!.name).toBe("Bitcoin 101");
    expect(ch!.satsrailProductTypeId).toBe("pt_123");
    expect(ch!.ref).toBeDefined();
    expect(mockCreateProductType).toHaveBeenCalledOnce();
  });

  it("updates existing channels by slug", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    await createChannel({ name: "Old Channel", slug: "my-channel", bio: "old bio" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "my-channel",
            name: "Updated Channel",
            bio: "new bio",
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.channels as { updated: number }).updated).toBe(1);
    expect((body.results.channels as { created: number }).created).toBe(0);

    const ch = await prisma.channel.findFirst({ where: { slug: "my-channel" } });
    expect(ch!.name).toBe("Updated Channel");
    expect(ch!.bio).toBe("new bio");
    expect(mockCreateProductType).not.toHaveBeenCalled();
  });

  it("creates new media within channels", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_456" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "test-channel",
            name: "Test Channel",
            media: [
              {
                name: "Video 1",
                source_url: "https://example.com/v1.mp4",
                media_type: "video",
                position: 1,
              },
              {
                name: "Audio 1",
                source_url: "https://example.com/a1.mp3",
                media_type: "audio",
                position: 2,
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);
    expect((body.results.media as { created: number }).created).toBe(2);

    const ch = await prisma.channel.findFirst({ where: { slug: "test-channel" } });
    const media = await prisma.media.findMany({
      where: { channelId: ch!.id },
      orderBy: { position: "asc" },
    });
    expect(media).toHaveLength(2);
    expect(media[0].name).toBe("Video 1");
    expect(media[1].name).toBe("Audio 1");
    expect(media[0].ref).toBeDefined();
  });

  it("creates SatsRail products and encrypts source URLs for media with product", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_789" });
    mockCreateProduct.mockResolvedValue({ id: "prod_abc" });
    mockGetProductKey.mockResolvedValue({
      key: productKey,
      key_fingerprint: "fp_123",
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "paid-channel",
            name: "Paid Channel",
            media: [
              {
                name: "Premium Video",
                source_url: "https://example.com/premium.mp4",
                media_type: "video",
                product: {
                  name: "Premium Access",
                  price_cents: 500,
                  currency: "USD",
                  access_duration_seconds: 86400,
                },
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    const mediaR = body.results.media as { created: number; errors: unknown[] };
    expect(mediaR.created).toBe(1);
    expect(mediaR.errors).toHaveLength(0);

    const mediaProducts = await findMediaProducts();
    expect(mediaProducts).toHaveLength(1);
    expect(mediaProducts[0].satsrailProductId).toBe("prod_abc");
    expect(mediaProducts[0].encryptedSource).toBeDefined();
    expect(mediaProducts[0].keyFingerprint).toBe("fp_123");

    expect(mockCreateProduct).toHaveBeenCalledWith("sk_live_test_key", expect.objectContaining({
      name: "Premium Access",
      price_cents: 500,
      currency: "USD",
      product_type_id: "pt_789",
    }));
  });

  it("resolves category_slug to categoryId on channels", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_cat" });

    const res = await POST(
      importRequest({
        version: "1.0",
        categories: [{ slug: "education", name: "Education" }],
        channels: [
          {
            slug: "learn-btc",
            name: "Learn BTC",
            category_slug: "education",
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.categories as { created: number }).created).toBe(1);
    expect((body.results.channels as { created: number }).created).toBe(1);

    const cat = await prisma.category.findFirst({ where: { slug: "education" } });
    const ch = await prisma.channel.findFirst({ where: { slug: "learn-btc" } });
    expect(ch!.categoryId).toBe(cat!.id);
  });

  it("matches existing media by ref within the same channel", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ slug: "existing-ch", name: "Existing" });
    await createMedia(channel.id, {
      name: "Old Name",
      ref: 42,
      blob: { kind: "url", url: "https://example.com/old.mp4" },
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "existing-ch",
            name: "Existing",
            media: [
              {
                ref: 42,
                name: "New Name",
                source_url: "https://example.com/new.mp4",
                media_type: "video",
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.media as { updated: number }).updated).toBe(1);
    expect((body.results.media as { created: number }).created).toBe(0);

    const media = await prisma.media.findFirst({ where: { ref: 42 } });
    expect(media!.name).toBe("New Name");
    const blob = media!.blob as { kind: string; url: string };
    expect(blob.url).toBe("https://example.com/new.mp4");
  });

  it("matches existing media by name when ref is not provided", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const channel = await createChannel({ slug: "name-match-ch", name: "Name Match" });
    await createMedia(channel.id, {
      name: "My Video",
      blob: { kind: "url", url: "https://example.com/old.mp4" },
      description: "old description",
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "name-match-ch",
            name: "Name Match",
            media: [
              {
                name: "My Video",
                source_url: "https://example.com/old.mp4",
                description: "new description",
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.media as { updated: number }).updated).toBe(1);

    const media = await prisma.media.findFirst({ where: { name: "My Video" } });
    expect(media!.description).toBe("new description");
  });

  it("reports partial success with per-record errors", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_err" });
    mockCreateProduct.mockRejectedValue(new Error("SatsRail API error 404"));
    mockGetProductKey.mockResolvedValue({
      key: generateProductKey(),
      key_fingerprint: "fp",
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "error-ch",
            name: "Error Channel",
            media: [
              {
                name: "Free Video",
                source_url: "https://example.com/free.mp4",
              },
              {
                name: "Paid Video",
                source_url: "https://example.com/paid.mp4",
                product: {
                  name: "Access",
                  price_cents: 100,
                },
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    const mediaR = body.results.media as { created: number; errors: { name: string; error: string }[] };
    expect(mediaR.created).toBe(2);
    expect(mediaR.errors).toHaveLength(1);
    expect(mediaR.errors[0].name).toBe("Paid Video");
    expect(mediaR.errors[0].error).toContain("Product creation failed");
    expect(body.success).toBe(false);
  });

  it("rejects imports exceeding 100 media items", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const media = Array.from({ length: 101 }, (_, i) => ({
      name: `Video ${i}`,
      source_url: `https://example.com/v${i}.mp4`,
    }));

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [{ slug: "big-ch", name: "Big Channel", media }],
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("Too many media items");
  });

  it("increments channel mediaCount when creating media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_count" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "count-ch",
            name: "Count Channel",
            media: [
              { name: "V1", source_url: "https://example.com/1.mp4" },
              { name: "V2", source_url: "https://example.com/2.mp4" },
              { name: "V3", source_url: "https://example.com/3.mp4" },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.media as { created: number }).created).toBe(3);

    const ch = await prisma.channel.findFirst({ where: { slug: "count-ch" } });
    expect(ch!.mediaCount).toBe(3);
  });

  it("honors JSON product.external_ref when creating a SatsRail product", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_ext" });
    mockCreateProduct.mockResolvedValue({ id: "prod_ext" });
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_ext" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "ext-channel",
            name: "External Channel",
            media: [
              {
                name: "Custom Ref Video",
                source_url: "https://example.com/x.mp4",
                product: {
                  name: "Custom",
                  price_cents: 200,
                  external_ref: "md_custom_77",
                },
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.media as { created: number }).created).toBe(1);

    expect(mockCreateProduct).toHaveBeenCalledWith(
      "sk_live_test_key",
      expect.objectContaining({ external_ref: "md_custom_77" })
    );
    const mediaProducts = await findMediaProducts();
    expect(mediaProducts[0].productExternalRef).toBe("md_custom_77");
  });

  it("reuses existing SatsRail product when JSON external_ref matches an existing one", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_reuse" });
    mockListProducts.mockResolvedValue({
      data: [{ id: "prod_existing", external_ref: "md_existing_5" }],
    });
    mockUpdateProduct.mockResolvedValue({});
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_reuse" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "reuse-channel",
            name: "Reuse Channel",
            media: [
              {
                name: "Reused Video",
                source_url: "https://example.com/r.mp4",
                product: {
                  name: "Reused",
                  price_cents: 300,
                  external_ref: "md_existing_5",
                },
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    const mediaR = body.results.media as { created: number; errors: unknown[] };
    expect(mediaR.created).toBe(1);
    expect(mediaR.errors).toHaveLength(0);

    expect(mockCreateProduct).not.toHaveBeenCalled();
    expect(mockUpdateProduct).toHaveBeenCalled();

    const mediaProducts = await findMediaProducts();
    expect(mediaProducts).toHaveLength(1);
    expect(mediaProducts[0].satsrailProductId).toBe("prod_existing");
    expect(mediaProducts[0].productExternalRef).toBe("md_existing_5");
  });

  it("falls back to md_{ref} when JSON product has no external_ref", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_fallback" });
    mockCreateProduct.mockResolvedValue({ id: "prod_fallback" });
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_fallback" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "fb-channel",
            name: "Fallback Channel",
            media: [
              {
                name: "Fallback Video",
                source_url: "https://example.com/fb.mp4",
                product: { name: "Plain", price_cents: 100 },
              },
            ],
          },
        ],
      })
    );

    await readSSEResult(res);
    const media = await prisma.media.findFirst({ where: { name: "Fallback Video" } });
    expect(mockCreateProduct).toHaveBeenCalledWith(
      "sk_live_test_key",
      expect.objectContaining({ external_ref: `md_${media!.ref}` })
    );
  });

  it("records per-category error when Category.create throws", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const spy = vi
      .spyOn(prisma.category, "create")
      .mockRejectedValueOnce(new Error("cat create failed") as never);

    const res = await POST(
      importRequest({
        version: "1.0",
        categories: [{ slug: "broken", name: "Broken" }],
      })
    );
    const body = await readSSEResult(res);
    const cr = body.results.categories as { errors: { name: string; error: string }[] };
    expect(cr.errors).toHaveLength(1);
    expect(cr.errors[0].name).toBe("Broken");
    expect(body.success).toBe(false);
    spy.mockRestore();
  });

  it("records per-channel error when Channel.create throws", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_chfail" });
    const spy = vi
      .spyOn(prisma.channel, "create")
      .mockRejectedValueOnce(new Error("channel create failed") as never);

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [{ slug: "bad-ch", name: "Bad Channel" }],
      })
    );
    const body = await readSSEResult(res);
    const cr = body.results.channels as { errors: { name: string; error: string }[] };
    expect(cr.errors).toHaveLength(1);
    expect(cr.errors[0].name).toBe("Bad Channel");
    spy.mockRestore();
  });

  it("treats unresolved category_slug as no category", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_nocat" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "orphan-cat-ch",
            name: "Orphan",
            category_slug: "does-not-exist",
          },
        ],
      })
    );
    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);
    const ch = await prisma.channel.findFirst({ where: { slug: "orphan-cat-ch" } });
    expect(ch!.categoryId == null).toBe(true);
  });

  it("skips SatsRail product creation when getMerchantKey returns null", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const merchantKeyMod = await import("@/lib/merchant-key");
    vi.mocked(merchantKeyMod.getMerchantKey).mockResolvedValueOnce(null);

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "no-sk-ch",
            name: "No SK",
            media: [
              { name: "Free", source_url: "https://example.com/free.mp4" },
            ],
          },
        ],
      })
    );
    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);
    expect((body.results.media as { created: number }).created).toBe(1);
    expect(mockCreateProductType).not.toHaveBeenCalled();

    const ch = await prisma.channel.findFirst({ where: { slug: "no-sk-ch" } });
    expect(ch!.satsrailProductTypeId == null).toBe(true);
  });

  it("creates a channel access product (Phase 4) when chData.product is present", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_ch_prod" });
    mockCreateProduct.mockResolvedValue({ id: "prod_ch_access" });
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_ch" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "ch-with-product",
            name: "Channel With Product",
            product: {
              name: "Channel Access",
              price_cents: 999,
              currency: "USD",
              access_duration_seconds: 86400,
              external_ref: "ch_custom_99",
            },
            media: [
              { name: "Item", source_url: "https://example.com/x.mp4" },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    const cp = body.results.channel_products as { created: number; errors: unknown[] };
    expect(cp.created).toBe(1);
    expect(cp.errors).toHaveLength(0);
  });

  it("creates a channel access product even when the channel has no media", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_ch_only" });
    mockCreateProduct.mockResolvedValue({ id: "prod_ch_only" });
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_ch_only" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "ch-no-media",
            name: "Ch No Media",
            product: { name: "Just Access", price_cents: 100 },
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);
    const cp = body.results.channel_products as { created: number };
    expect(cp.created).toBe(1);
  });

  it("skips Phase 4 entirely when no channels declare a product", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_skip4" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          { slug: "no-prod-ch", name: "No Prod" },
        ],
      })
    );
    const body = await readSSEResult(res);
    const cp = body.results.channel_products as { created: number; errors: unknown[] };
    expect(cp.created).toBe(0);
    expect(cp.errors).toHaveLength(0);
  });

  it("creates product type for existing channel when importing media with products", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    await createChannel({
      slug: "no-pt-ch",
      name: "No Product Type",
      satsrailProductTypeId: null,
    });

    const productKey = generateProductKey();
    mockCreateProductType.mockResolvedValue({ id: "pt_new" });
    mockCreateProduct.mockResolvedValue({ id: "prod_new" });
    mockGetProductKey.mockResolvedValue({ key: productKey, key_fingerprint: "fp_new" });

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "no-pt-ch",
            name: "No Product Type",
            media: [
              {
                name: "Paid Video",
                source_url: "https://example.com/paid.mp4",
                product: {
                  name: "Access",
                  price_cents: 100,
                  currency: "USD",
                },
              },
            ],
          },
        ],
      })
    );

    const body = await readSSEResult(res);
    expect((body.results.channels as { updated: number }).updated).toBe(1);

    expect(mockCreateProductType).toHaveBeenCalledOnce();

    const ch = await prisma.channel.findFirst({ where: { slug: "no-pt-ch" } });
    expect(ch!.satsrailProductTypeId).toBe("pt_new");

    expect(mockCreateProduct).toHaveBeenCalledOnce();
    const mediaProducts = await findMediaProducts();
    expect(mediaProducts).toHaveLength(1);
  });

  it("category.update uses default active=true when not provided", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    await createCategory({ slug: "music", name: "Music", active: false, position: 5 });

    // Update WITHOUT active or position to exercise default branches
    const res = await POST(
      importRequest({
        version: "1.0",
        categories: [{ slug: "music", name: "Music Renamed" }],
      })
    );
    const body = await readSSEResult(res);
    expect((body.results.categories as { updated: number }).updated).toBe(1);
    const cat = await prisma.category.findFirst({ where: { slug: "music" } });
    expect(cat!.active).toBe(true); // fallback
    expect(cat!.position).toBe(5); // preserved (not in payload)
  });

  it("category.create uses default position when no max exists and position not provided", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    const res = await POST(
      importRequest({
        version: "1.0",
        // Note: no position field
        categories: [{ slug: "first-cat", name: "First", active: false }],
      })
    );
    await readSSEResult(res);
    const cat = await prisma.category.findFirst({ where: { slug: "first-cat" } });
    expect(cat!.position).toBe(1); // (maxPos?.position ?? 0) + 1
    expect(cat!.active).toBe(false);
  });

  it("skips channel product when channel has no satsrailProductTypeId", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    // No SK key returns null → no product type can be created
    const merchantKey = await import("@/lib/merchant-key");
    vi.mocked(merchantKey.getMerchantKey).mockResolvedValueOnce(null);

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "skip-cp-ch",
            name: "Skip CP",
            product: {
              name: "X",
              price_cents: 100,
            },
          },
        ],
      })
    );
    const body = await readSSEResult(res);
    // Channel created, but Phase 4 (channel_products) entirely skipped (no sk)
    expect((body.results.channels as { created: number }).created).toBe(1);
  });

  it("creates a channel using all defaults (bio=empty, nsfw=false, etc.)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    mockCreateProductType.mockResolvedValue({ id: "pt_defaults" });

    const res = await POST(
      importRequest({
        version: "1.0",
        // Minimal payload — no bio, profile_image_url, etc.
        channels: [{ slug: "minimal-ch", name: "Minimal" }],
      })
    );
    const body = await readSSEResult(res);
    expect((body.results.channels as { created: number }).created).toBe(1);

    const ch = await prisma.channel.findFirst({ where: { slug: "minimal-ch" } });
    expect(ch!.bio).toBe("");
    expect(ch!.nsfw).toBe(false);
    expect(ch!.profileImageUrl).toBe("");
    expect(ch!.active).toBe(true);
  });

  it("uses default channel update path when sk is null (skips ensureChannelProductType)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });
    await createChannel({ slug: "existing-no-sk", name: "Existing No SK" });
    const merchantKey = await import("@/lib/merchant-key");
    vi.mocked(merchantKey.getMerchantKey).mockResolvedValueOnce(null);

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [
          {
            slug: "existing-no-sk",
            name: "Existing No SK Updated",
            media: [{ name: "V1", source_url: "https://example.com/v.mp4", product: { name: "P", price_cents: 100 } }],
          },
        ],
      })
    );
    const body = await readSSEResult(res);
    expect((body.results.channels as { updated: number }).updated).toBe(1);
    // ensureChannelProductType not called → no createProductType
    expect(mockCreateProductType).not.toHaveBeenCalled();
  });

  it("catches the outer try/catch and emits an 'error' SSE event", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com", type: "admin", role: "owner" },
    });

    // Force getMerchantKey to throw so the outer try/catch handles it
    const merchantKey = await import("@/lib/merchant-key");
    vi.mocked(merchantKey.getMerchantKey).mockRejectedValueOnce(new Error("KMS down"));

    const res = await POST(
      importRequest({
        version: "1.0",
        channels: [{ slug: "err-ch", name: "Err Ch" }],
      })
    );
    // The stream emits an "error" event — parse to confirm
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("KMS down");
  });
});
