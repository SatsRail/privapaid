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
    // Replace $queryRaw with a one-shot rejecter. The real testcontainer
    // Postgres stays up; we only simulate the failure mode at the call site.
    const original = prisma.$queryRaw;
    (prisma as unknown as { $queryRaw: () => Promise<unknown> }).$queryRaw =
      () => Promise.reject(new Error("offline"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    try {
      const { GET } = await import("@/app/api/health/route");
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.db).toBe("disconnected");
    } finally {
      (prisma as unknown as { $queryRaw: typeof original }).$queryRaw = original;
    }
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

  it("reports satsrail:unreachable without failing the container healthcheck", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    process.env.SATSRAIL_API_URL = "https://satsrail.test/api/v1";

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    // A portal outage must not restart the app (railway.toml restarts
    // ON_FAILURE against this path), so it is reported, not fatal.
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.satsrail).toBe("unreachable");
  });

  it("probes the built-in default when SATSRAIL_API_URL is unset", async () => {
    vi.resetModules();
    delete process.env.SATSRAIL_API_URL;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    // Previously this reported "not_configured" and skipped the probe, which
    // meant a default deployment could not tell whether it was reaching the
    // portal at all.
    expect(res.status).toBe(200);
    expect(body.satsrail).toBe("reachable");
    expect(global.fetch).toHaveBeenCalled();
  });

  it("reports the URL it probed, with the legacy host normalized", async () => {
    // `@/config/instance` reads env once at module load, so the registry has
    // to be reset for a fresh SATSRAIL_API_URL to take effect.
    vi.resetModules();
    process.env.SATSRAIL_API_URL = "https://satsrail.com/api/v1";
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();

    // The bare apex does not resolve; config rewrites it onto the API host.
    expect(body.satsrail_url).toBe("https://app.satsrail.com/api/v1");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.satsrail.com/api/v1/pub/exchanges",
      expect.anything()
    );
  });
});
