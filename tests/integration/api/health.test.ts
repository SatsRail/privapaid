import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { setupTestDB, teardownTestDB } from "../../helpers/postgres";
import { prisma } from "@/lib/prisma";

const originalFetch = global.fetch;
const originalSatsrailUrl = process.env.SATSRAIL_API_URL;

describe("GET /api/health", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SATSRAIL_API_URL = originalSatsrailUrl;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.SATSRAIL_API_URL = originalSatsrailUrl;
  });

  it("returns 200 when all services are healthy", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("connected");
    expect(body.satsrail).toBe("reachable");
  });

  it("returns 503 with db:disconnected when prisma.$queryRaw rejects", async () => {
    // Spy on $queryRaw and make it reject once. The real testcontainer Postgres
    // stays up; we only simulate the failure mode at the call site.
    vi.spyOn(prisma, "$queryRaw" as never).mockRejectedValueOnce(
      new Error("offline") as never
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("disconnected");
  });

  it("reports http_<status> when satsrail returns non-ok", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.satsrail).toBe("http_500");
  });

  it("reports satsrail:unreachable and degrades status when fetch throws", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.satsrail).toBe("unreachable");
  });

  it("reports satsrail:not_configured when SATSRAIL_API_URL is unset", async () => {
    delete process.env.SATSRAIL_API_URL;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.satsrail).toBe("not_configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
