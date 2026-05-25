import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createCustomer, createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

describe("Customer model", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a customer with required fields", async () => {
    const customer = await createCustomer({ nickname: "testuser" });
    expect(customer.nickname).toBe("testuser");
    expect(customer.passwordHash).toBeDefined();
    expect(customer.id).toBeDefined();
  });

  it("sets default values", async () => {
    const customer = await createCustomer();
    expect(customer.profileImageBytes).toBeNull();
    expect(customer.deletedAt).toBeNull();
  });

  it("creates timestamps", async () => {
    const customer = await createCustomer();
    expect(customer.createdAt).toBeInstanceOf(Date);
    expect(customer.updatedAt).toBeInstanceOf(Date);
  });

  it("enforces nickname uniqueness", async () => {
    await createCustomer({ nickname: "uniqueuser" });
    await expect(createCustomer({ nickname: "uniqueuser" })).rejects.toThrow();
  });

  it("stores purchases as related rows", async () => {
    const customer = await createCustomer();
    await prisma.purchase.create({
      data: {
        customerId: customer.id,
        satsrailOrderId: "order_123",
        satsrailProductId: "prod_456",
      },
    });

    const found = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: { purchases: true },
    });
    expect(found!.purchases).toHaveLength(1);
    expect(found!.purchases[0].satsrailOrderId).toBe("order_123");
  });

  it("stores favorite channels via relation", async () => {
    const customer = await createCustomer();
    const channel = await createChannel();
    await prisma.customer.update({
      where: { id: customer.id },
      data: { favoriteChannels: { connect: { id: channel.id } } },
    });

    const found = await prisma.customer.findUnique({
      where: { id: customer.id },
      include: { favoriteChannels: true },
    });
    expect(found!.favoriteChannels).toHaveLength(1);
    expect(found!.favoriteChannels[0].id).toBe(channel.id);
  });
});
