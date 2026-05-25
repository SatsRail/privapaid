import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

// Mock rate limit
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

const { customerIdRef } = vi.hoisted(() => ({
  customerIdRef: { id: "" as string },
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireCustomerApi: vi.fn().mockImplementation(async () => ({
    id: customerIdRef.id,
    name: "testuser",
  })),
}));

import { NextResponse } from "next/server";
import { GET } from "@/app/api/customer/comments/route";
import { requireCustomerApi } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { createChannel, createMedia, createCustomer } from "../../helpers/factories";

describe("GET /api/customer/comments", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  async function seedCustomer() {
    const customer = await createCustomer({ nickname: "testuser" });
    customerIdRef.id = customer.id;
    return customer;
  }

  it("returns empty data when customer has no comments", async () => {
    await seedCustomer();
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("returns comments for the authenticated customer", async () => {
    const customer = await seedCustomer();
    const channel = await createChannel();
    const media = await createMedia(channel.id, { name: "Test Video" });

    await prisma.comment.create({
      data: {
        mediaId: media.id,
        customerId: customer.id,
        nickname: "testuser",
        body: "Great video!",
      },
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].body).toBe("Great video!");
    expect(body.data[0].nickname).toBe("testuser");
    expect(body.data[0].media).toBeTruthy();
    expect(body.data[0].media.name).toBe("Test Video");
    expect(body.data[0].media.channel_slug).toBe(channel.slug);
    expect(body.data[0].media.channel_name).toBe(channel.name);
  });

  it("does not return comments from other customers", async () => {
    await seedCustomer();
    const otherCustomer = await createCustomer({ nickname: "otheruser" });
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    await prisma.comment.create({
      data: {
        mediaId: media.id,
        customerId: otherCustomer.id,
        nickname: "otheruser",
        body: "Someone else's comment",
      },
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(0);
  });

  it("returns comments sorted by createdAt descending", async () => {
    const customer = await seedCustomer();
    const channel = await createChannel();
    const media = await createMedia(channel.id);

    // Need raw SQL because Prisma blocks setting createdAt on @default(now()) fields
    await prisma.$executeRaw`
      INSERT INTO "Comment" ("id", "mediaId", "customerId", "nickname", "body", "createdAt", "updatedAt")
      VALUES ('first', ${media.id}, ${customer.id}, 'testuser', 'First comment', '2024-01-01 00:00:00', '2024-01-01 00:00:00')
    `;
    await prisma.$executeRaw`
      INSERT INTO "Comment" ("id", "mediaId", "customerId", "nickname", "body", "createdAt", "updatedAt")
      VALUES ('second', ${media.id}, ${customer.id}, 'testuser', 'Second comment', '2024-06-01 00:00:00', '2024-06-01 00:00:00')
    `;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].body).toBe("Second comment");
    expect(body.data[1].body).toBe("First comment");
  });

  it("handles comments with deleted media gracefully", async () => {
    const customer = await seedCustomer();
    // Create a media row, then delete it directly so cascade kicks in,
    // OR insert a comment with mediaId pointing at a non-existent row.
    // FK Cascade means we can't have orphans; use a deleted parent channel cascade.
    // Instead, simulate "deleted media" by setting comment.mediaId to a valid
    // but soft-deleted media row.
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    await prisma.comment.create({
      data: {
        mediaId: media.id,
        customerId: customer.id,
        nickname: "testuser",
        body: "Comment on deleted media",
      },
    });
    // Soft-delete the media
    await prisma.media.update({
      where: { id: media.id },
      data: { deletedAt: new Date() },
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].body).toBe("Comment on deleted media");
    // The route filters soft-deleted media → renders null
    expect(body.data[0].media).toBeNull();
  });

  it("returns 401 when requireCustomerApi denies access", async () => {
    vi.mocked(requireCustomerApi).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
