import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createCustomer } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Mock rate limit to not interfere with tests
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers (required by rate-limit in case it's not fully mocked)
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock HIBP breach check. The real signup hits api.pwnedpasswords.com;
// in tests we always return "not breached" so the existing fixtures
// (some of which use well-known passwords like "MySecurePass123!") keep
// working. There's a dedicated unit suite at
// tests/unit/lib/breached-password.test.ts that exercises the helper
// itself, including the breached path.
vi.mock("@/lib/breached-password", () => ({
  checkBreachedPassword: vi.fn().mockResolvedValue({ breached: false }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/customer/signup/route";

function signupRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/customer/signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/customer/signup", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("creates a customer with valid data", async () => {
    const req = signupRequest({
      nickname: "newuser",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.nickname).toBe("newuser");
    expect(body.id).toBeDefined();

    // Verify customer exists in DB
    const customer = await prisma.customer.findFirst({ where: { nickname: "newuser" } });
    expect(customer).toBeTruthy();
  });

  it("returns 400 for short password", async () => {
    const req = signupRequest({
      nickname: "testuser",
      password: "12345",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for invalid nickname (special chars)", async () => {
    const req = signupRequest({
      nickname: "user name!",
      password: "MySecurePass123!",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate nickname", async () => {
    await createCustomer({ nickname: "takenname" });

    const req = signupRequest({
      nickname: "takenname",
      password: "MySecurePass123!",
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already taken");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/customer/signup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing fields", async () => {
    const req = signupRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns the rate-limit response when limited", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const { NextResponse } = await import("next/server");
    vi.mocked(rateLimit).mockResolvedValueOnce(
      NextResponse.json({ error: "Too Many Requests" }, { status: 429 })
    );

    const req = signupRequest({
      nickname: "ratelimited",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);

    // Verify rate-limit short-circuit ran before DB insert
    const count = await prisma.customer.count({ where: { nickname: "ratelimited" } });
    expect(count).toBe(0);
  });

  it("returns 409 when Prisma raises a duplicate key error during create", async () => {
    const spy = vi.spyOn(prisma.customer, "create").mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }) as never
    );

    const req = signupRequest({
      nickname: "racey",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already taken/);
    spy.mockRestore();
  });

  it("returns 500 when prisma.customer.create throws a non-duplicate error", async () => {
    const spy = vi
      .spyOn(prisma.customer, "create")
      .mockRejectedValueOnce(new Error("db down") as never);

    const req = signupRequest({
      nickname: "broken",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Internal server error/i);
    spy.mockRestore();
  });

  it("returns 422 when the password appears in HIBP breach data", async () => {
    const { checkBreachedPassword } = await import("@/lib/breached-password");
    (checkBreachedPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      breached: true,
      count: 12345,
    });

    const req = signupRequest({
      nickname: "breachuser",
      password: "common-leaked-password-99",
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/known data breaches/i);

    // And the Customer was NOT created.
    const exists = await prisma.customer.findFirst({ where: { nickname: "breachuser" } });
    expect(exists).toBeNull();
  });
});
