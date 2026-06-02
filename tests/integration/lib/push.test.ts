import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mock web-push so no real network calls happen; assert on what we'd send.
const { mockSetVapidDetails, mockSendNotification } = vi.hoisted(() => ({
  mockSetVapidDetails: vi.fn(),
  mockSendNotification: vi.fn(),
}));
vi.mock("web-push", () => ({
  setVapidDetails: mockSetVapidDetails,
  sendNotification: mockSendNotification,
}));

const { mockGetInstanceConfig } = vi.hoisted(() => ({ mockGetInstanceConfig: vi.fn() }));
vi.mock("@/config/instance", () => ({ getInstanceConfig: mockGetInstanceConfig }));

// push.ts re-reads VAPID env on every call (no memoization), so static import
// is fine — we just flip env per test.
import { sendNewContentNotifications } from "@/lib/push";

function setVapidEnv(on: boolean) {
  if (on) {
    process.env.VAPID_PUBLIC_KEY = "BPublicKeyTestValue";
    process.env.VAPID_PRIVATE_KEY = "PrivateKeyTestValue";
    process.env.VAPID_SUBJECT = "mailto:ops@test.example.com";
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  }
}

async function seedSub(channelId: string, endpoint: string) {
  return prisma.pushSubscription.create({
    data: { channelId, endpoint, p256dh: "p", auth: "a" },
  });
}

describe("sendNewContentNotifications", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
    setVapidEnv(false);
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    setVapidEnv(false);
    delete process.env.PUSH_SEND_CONCURRENCY;
    delete process.env.PUSH_SEND_TIMEOUT_MS;
  });

  it("no-ops (sends nothing) when VAPID env is unset", async () => {
    setVapidEnv(false);
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "no-vapid" });
    await seedSub(ch.id, "https://push/endpoint-x");

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "no-vapid",
      channelName: "No Vapid",
      media: { id: "m1", name: "Hello" },
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("no-ops when the channel has no subscriptions", async () => {
    setVapidEnv(true);
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "empty" });

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "empty",
      channelName: "Empty",
      media: { id: "m1", name: "Hello" },
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("sends a metadata-only payload to every subscription", async () => {
    setVapidEnv(true);
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    mockSendNotification.mockResolvedValue({});
    const ch = await createChannel({ slug: "live" });
    await seedSub(ch.id, "https://push/e1");
    await seedSub(ch.id, "https://push/e2");

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "live",
      channelName: "Live Channel",
      channelImage: "/api/images/channel/live-1",
      media: { id: "media-123", name: "Fresh Drop" },
    });

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(mockSendNotification.mock.calls[0][1] as string);
    expect(payload.title).toBe("Live Channel");
    expect(payload.body).toBe("New: Fresh Drop");
    expect(payload.url).toBe("https://test.example.com/c/live/media-123");
    // App-relative channel image is resolved to an absolute icon URL.
    expect(payload.icon).toBe("https://test.example.com/api/images/channel/live-1");
    // No content/source leakage — metadata + deep link only.
    expect(JSON.stringify(payload)).not.toContain("sourceUrl");
    // Successful sends are not pruned.
    expect(await prisma.pushSubscription.count({ where: { channelId: ch.id } })).toBe(2);
  });

  it("prunes endpoints that return 410/404 and keeps the rest", async () => {
    setVapidEnv(true);
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "prune" });
    const dead410 = "https://push/dead-410";
    const dead404 = "https://push/dead-404";
    const alive = "https://push/alive";
    await seedSub(ch.id, dead410);
    await seedSub(ch.id, dead404);
    await seedSub(ch.id, alive);

    mockSendNotification.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint === dead410) return Promise.reject({ statusCode: 410 });
      if (sub.endpoint === dead404) return Promise.reject({ statusCode: 404 });
      return Promise.resolve({});
    });

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "prune",
      channelName: "Prune",
      media: { id: "m1", name: "X" },
    });

    const remaining = await prisma.pushSubscription.findMany({ where: { channelId: ch.id } });
    expect(remaining.map((r) => r.endpoint)).toEqual([alive]);
  });

  it("does NOT prune on transient (5xx) errors", async () => {
    setVapidEnv(true);
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "transient" });
    await seedSub(ch.id, "https://push/temp-fail");
    mockSendNotification.mockRejectedValue({ statusCode: 503 });

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "transient",
      channelName: "T",
      media: { id: "m1", name: "X" },
    });

    expect(await prisma.pushSubscription.count({ where: { channelId: ch.id } })).toBe(1);
  });

  it("never exceeds the configured concurrency while still sending to every sub", async () => {
    setVapidEnv(true);
    process.env.PUSH_SEND_CONCURRENCY = "3";
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "bounded" });
    const TOTAL = 7;
    for (let i = 0; i < TOTAL; i += 1) {
      await seedSub(ch.id, `https://push/sub-${i}`);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    mockSendNotification.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold briefly so workers overlap and the cap is observable.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {};
    });

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "bounded",
      channelName: "Bounded",
      media: { id: "m1", name: "X" },
    });

    expect(mockSendNotification).toHaveBeenCalledTimes(TOTAL);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // proves they actually ran in parallel
  });

  it("treats a per-send timeout as transient — completes without hanging, no prune", async () => {
    setVapidEnv(true);
    process.env.PUSH_SEND_TIMEOUT_MS = "20";
    mockGetInstanceConfig.mockResolvedValue({ domain: "test.example.com" });
    const ch = await createChannel({ slug: "slow" });
    await seedSub(ch.id, "https://push/never-resolves");
    // A send that never settles — only the timeout unblocks the worker.
    mockSendNotification.mockImplementation(() => new Promise(() => {}));

    await sendNewContentNotifications({
      channelId: ch.id,
      channelSlug: "slow",
      channelName: "Slow",
      media: { id: "m1", name: "X" },
    });

    // A timeout is transient (not a 410) → the subscription is kept.
    expect(await prisma.pushSubscription.count({ where: { channelId: ch.id } })).toBe(1);
  });
});
