import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock connectDB — readyState manipulated per-test
const mockConnection = { readyState: 1 };
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi
    .fn()
    .mockImplementation(async () => ({ connection: mockConnection })),
}));

const originalFetch = global.fetch;
const originalSatsrailUrl = process.env.SATSRAIL_API_URL;

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockConnection.readyState = 1;
    process.env.SATSRAIL_API_URL = originalSatsrailUrl;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.SATSRAIL_API_URL = originalSatsrailUrl;
  });

  it("returns 200 when all services are healthy", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.mongo).toBe("connected");
    expect(body.satsrail).toBe("reachable");
  });

  it("reports non-1 mongo readyState verbatim and still returns 200 if satsrail is up", async () => {
    mockConnection.readyState = 2; // "connecting"
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.mongo).toBe("state_2");
  });

  it("returns 503 with mongo:disconnected when connectDB throws", async () => {
    const { connectDB } = await import("@/lib/mongodb");
    vi.mocked(connectDB).mockRejectedValueOnce(new Error("offline"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.mongo).toBe("disconnected");
  });

  it("reports http_<status> when satsrail returns non-ok", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

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
