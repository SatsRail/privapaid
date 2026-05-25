import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia, createCustomer } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Comment model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a comment with required fields", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const comment = await prisma.comment.create({
      data: {
        mediaId: media.id,
        nickname: "testuser",
        body: "Great content!",
      },
    });
    expect(comment.id).toBeDefined();
    expect(comment.mediaId).toBe(media.id);
    expect(comment.nickname).toBe("testuser");
    expect(comment.body).toBe("Great content!");
  });

  it("creates timestamps", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const comment = await prisma.comment.create({
      data: { mediaId: media.id, nickname: "user", body: "Nice" },
    });
    expect(comment.createdAt).toBeInstanceOf(Date);
    expect(comment.updatedAt).toBeInstanceOf(Date);
  });

  it("allows optional customerId", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const customer = await createCustomer();

    const withCustomer = await prisma.comment.create({
      data: {
        mediaId: media.id,
        customerId: customer.id,
        nickname: customer.nickname,
        body: "From a customer",
      },
    });
    expect(withCustomer.customerId).toBe(customer.id);

    const anonymous = await prisma.comment.create({
      data: {
        mediaId: media.id,
        nickname: "anon",
        body: "Anonymous comment",
      },
    });
    expect(anonymous.customerId).toBeNull();
  });

  it("queries comments by mediaId", async () => {
    const channel = await createChannel();
    const media1 = await createMedia(channel.id, { name: "Media 1" });
    const media2 = await createMedia(channel.id, { name: "Media 2" });

    await prisma.comment.create({
      data: { mediaId: media1.id, nickname: "user1", body: "On media 1" },
    });
    await prisma.comment.create({
      data: { mediaId: media1.id, nickname: "user2", body: "Also on media 1" },
    });
    await prisma.comment.create({
      data: { mediaId: media2.id, nickname: "user3", body: "On media 2" },
    });

    const comments = await prisma.comment.findMany({ where: { mediaId: media1.id } });
    expect(comments).toHaveLength(2);
  });
});
