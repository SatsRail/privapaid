import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type mongooseType from "mongoose";

const originalUri = process.env.MONGODB_URI;

const { connectMock, mongooseModule } = vi.hoisted(() => {
  const connect = vi.fn();
  return {
    connectMock: connect,
    mongooseModule: { connect, default: { connect } },
  };
});

vi.mock("mongoose", () => mongooseModule);

// `lib/mongodb` already declares `global.mongoose` with the MongooseCache type;
// reuse that declaration rather than redeclaring it here.
type MutableGlobal = typeof globalThis & {
  mongoose?: {
    conn: typeof mongooseType | null;
    promise: Promise<typeof mongooseType> | null;
  };
};

describe("connectDB (lib/mongodb)", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as MutableGlobal).mongoose = undefined;
    connectMock.mockReset();
    process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  });

  afterEach(() => {
    process.env.MONGODB_URI = originalUri;
    (globalThis as MutableGlobal).mongoose = undefined;
  });

  it("throws when MONGODB_URI is not set", async () => {
    delete process.env.MONGODB_URI;
    const { connectDB } = await import("@/lib/mongodb");
    await expect(connectDB()).rejects.toThrow(/MONGODB_URI/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("returns the cached connection on subsequent calls", async () => {
    const fakeConn = { connection: { id: 1 } } as unknown as typeof mongooseType;
    connectMock.mockResolvedValue(fakeConn);

    const { connectDB } = await import("@/lib/mongodb");
    const first = await connectDB();
    const second = await connectDB();

    expect(first).toBe(fakeConn);
    expect(second).toBe(fakeConn);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("clears the cached promise and rethrows when connect rejects", async () => {
    connectMock.mockRejectedValueOnce(new Error("connect failed"));
    const { connectDB } = await import("@/lib/mongodb");

    await expect(connectDB()).rejects.toThrow("connect failed");

    // Second call retries (promise was nulled on failure)
    const fakeConn = { connection: { id: 2 } } as unknown as typeof mongooseType;
    connectMock.mockResolvedValueOnce(fakeConn);
    const result = await connectDB();
    expect(result).toBe(fakeConn);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the global mongoose cache across imports", async () => {
    const fakeConn = { connection: { id: 3 } } as unknown as typeof mongooseType;
    (globalThis as MutableGlobal).mongoose = { conn: fakeConn, promise: null };

    const { connectDB } = await import("@/lib/mongodb");
    const result = await connectDB();
    expect(result).toBe(fakeConn);
    expect(connectMock).not.toHaveBeenCalled();
  });
});
