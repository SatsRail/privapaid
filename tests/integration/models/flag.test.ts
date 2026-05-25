import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia, createCustomer } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Flag model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a flag with required fields", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const customer = await createCustomer();
    const flag = await prisma.flag.create({
      data: {
        mediaId: media.id,
        customerId: customer.id,
        flagType: "inappropriate",
      },
    });
    expect(flag.id).toBeDefined();
    expect(flag.mediaId).toBe(media.id);
    expect(flag.customerId).toBe(customer.id);
    expect(flag.flagType).toBe("inappropriate");
  });

  it("creates timestamps", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const customer = await createCustomer();
    const flag = await prisma.flag.create({
      data: { mediaId: media.id, customerId: customer.id, flagType: "spam" },
    });
    expect(flag.createdAt).toBeInstanceOf(Date);
    expect(flag.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces one flag per customer per media", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const customer = await createCustomer();

    await prisma.flag.create({
      data: { mediaId: media.id, customerId: customer.id, flagType: "inappropriate" },
    });
    await expect(
      prisma.flag.create({
        data: { mediaId: media.id, customerId: customer.id, flagType: "spam" },
      })
    ).rejects.toThrow();
  });

  it("allows same customer to flag different media", async () => {
    const channel = await createChannel();
    const media1 = await createMedia(channel.id, { name: "Media 1" });
    const media2 = await createMedia(channel.id, { name: "Media 2" });
    const customer = await createCustomer();

    const flag1 = await prisma.flag.create({
      data: { mediaId: media1.id, customerId: customer.id, flagType: "spam" },
    });
    const flag2 = await prisma.flag.create({
      data: { mediaId: media2.id, customerId: customer.id, flagType: "spam" },
    });
    expect(flag1.id).toBeDefined();
    expect(flag2.id).toBeDefined();
  });

  it("allows different customers to flag same media", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const customer1 = await createCustomer();
    const customer2 = await createCustomer();

    const flag1 = await prisma.flag.create({
      data: { mediaId: media.id, customerId: customer1.id, flagType: "inappropriate" },
    });
    const flag2 = await prisma.flag.create({
      data: { mediaId: media.id, customerId: customer2.id, flagType: "inappropriate" },
    });
    expect(flag1.id).toBeDefined();
    expect(flag2.id).toBeDefined();
  });

  it("queries flags by mediaId", async () => {
    const channel = await createChannel();
    const media = await createMedia(channel.id);
    const c1 = await createCustomer();
    const c2 = await createCustomer();

    await prisma.flag.create({
      data: { mediaId: media.id, customerId: c1.id, flagType: "spam" },
    });
    await prisma.flag.create({
      data: { mediaId: media.id, customerId: c2.id, flagType: "inappropriate" },
    });

    const flags = await prisma.flag.findMany({ where: { mediaId: media.id } });
    expect(flags).toHaveLength(2);
  });
});
