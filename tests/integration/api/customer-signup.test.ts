import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/mongodb";
import { createCustomer } from "../../helpers/factories";
import Customer from "@/models/Customer";

// Mock rate limit to not interfere with tests
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue(null),
}));

// Mock next/headers (required by rate-limit in case it's not fully mocked)
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));

// Mock connectDB to use the already-connected mongoose instance
vi.mock("@/lib/mongodb", () => ({
  connectDB: vi.fn().mockImplementation(async () => mongoose),
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
    const customer = await Customer.findOne({ nickname: "newuser" });
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
    const count = await Customer.countDocuments({ nickname: "ratelimited" });
    expect(count).toBe(0);
  });

  it("returns 409 when MongoDB raises a duplicate key error during create", async () => {
    const spy = vi
      .spyOn(Customer, "create")
      .mockRejectedValueOnce({ code: 11000, message: "E11000 duplicate key" } as never);

    const req = signupRequest({
      nickname: "racey",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already taken/);
    spy.mockRestore();
  });

  it("returns 500 when Customer.create throws a non-duplicate error", async () => {
    const spy = vi
      .spyOn(Customer, "create")
      .mockRejectedValueOnce(new Error("mongo down") as never);

    const req = signupRequest({
      nickname: "broken",
      password: "MySecurePass123!",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Internal server error/i);
    spy.mockRestore();
  });
});
