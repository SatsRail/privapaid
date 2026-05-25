import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mocks — MUST be before route imports
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// auth mock — overridden per test
const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

import { POST as createFlag } from "@/app/api/media/[id]/flags/route";
import { prisma } from "@/lib/prisma";

let refSeed = 5000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

function jsonRequest(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

describe("Flags API — POST /api/media/[id]/flags", () => {
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

  async function seedWithProduct() {
    const channel = await prisma.channel.create({
      data: {
        ref: nextRef(),
        slug: `ch-flags-${nextRef()}`,
        name: "Flags Channel",
      },
    });

    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "Flaggable Video",
        sourceUrl: "https://example.com/flag.mp4",
        mediaType: "video",
        position: 1,
      },
    });

    await prisma.mediaProduct.create({
      data: {
        mediaId: media.id,
        satsrailProductId: "prod_flag",
        encryptedSourceUrl: "encrypted_blob",
      },
    });

    return { channelId: channel.id, mediaId: media.id };
  }

  async function seedCustomerWithPurchase(nickname: string) {
    const customer = await prisma.customer.create({
      data: {
        nickname,
        passwordHash: "hashed",
        purchases: {
          create: [{
            satsrailOrderId: "ord_flag_1",
            satsrailProductId: "prod_flag",
          }],
        },
      },
    });
    return customer;
  }

  it("creates a flag from customer with purchase", async () => {
    const { mediaId } = await seedWithProduct();
    const customer = await seedCustomerWithPurchase("flagger1");

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "flagger1", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/flags`, "POST", {
      flag_type: "inappropriate",
    });
    const res = await createFlag(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);

    // Verify flag was created
    const flag = await prisma.flag.findFirst({ where: { mediaId, customerId: customer.id } });
    expect(flag).toBeTruthy();
    expect(flag!.flagType).toBe("inappropriate");

    // Verify flagsCount incremented
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    expect(media!.flagsCount).toBe(1);
  });

  it("returns 409 for duplicate flag (same customer + media)", async () => {
    const { mediaId } = await seedWithProduct();
    const customer = await seedCustomerWithPurchase("flagger2");

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "flagger2", role: "customer" },
    });

    // Create first flag
    await prisma.flag.create({
      data: {
        mediaId,
        customerId: customer.id,
        flagType: "inappropriate",
      },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/flags`, "POST", {
      flag_type: "spam",
    });
    const res = await createFlag(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("Already flagged");
  });

  it("returns 403 without purchase", async () => {
    const { mediaId } = await seedWithProduct();

    const customer = await prisma.customer.create({
      data: {
        nickname: "nopurchaseflagger",
        passwordHash: "hashed",
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "nopurchaseflagger", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/flags`, "POST", {
      flag_type: "inappropriate",
    });
    const res = await createFlag(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Purchase required to flag content");
  });

  it("returns 401 for unauthenticated user", async () => {
    const { mediaId } = await seedWithProduct();

    mockAuth.mockResolvedValue(null);

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/flags`, "POST", {
      flag_type: "spam",
    });
    const res = await createFlag(req, { params: Promise.resolve({ id: mediaId }) });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 for non-existent media", async () => {
    const fakeId = "ckmissingfakefakefakefake";
    const customer = await seedCustomerWithPurchase("flagger3");

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "flagger3", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${fakeId}/flags`, "POST", {
      flag_type: "broken",
    });
    const res = await createFlag(req, { params: Promise.resolve({ id: fakeId }) });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Media not found");
  });

  it("returns 400 for invalid body (missing flag_type)", async () => {
    const { mediaId } = await seedWithProduct();
    const customer = await seedCustomerWithPurchase("flagger4");

    mockAuth.mockResolvedValue({
      user: { id: customer.id, name: "flagger4", role: "customer" },
    });

    const req = jsonRequest(`http://localhost:3000/api/media/${mediaId}/flags`, "POST", {});
    const res = await createFlag(req, { params: Promise.resolve({ id: mediaId }) });
    expect(res.status).toBe(400);
  });
});
