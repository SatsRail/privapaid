import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { checkBreachedPassword } from "@/lib/breached-password";

function sha1Upper(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
}

function mockFetchReturning(body: string, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe("checkBreachedPassword", () => {
  it("reports breached when the SHA1 suffix appears in the HIBP response", async () => {
    const password = "Password1!";
    const digest = sha1Upper(password);
    const suffix = digest.slice(5);
    // HIBP returns: SUFFIX:COUNT lines. Include the matching suffix plus
    // a couple of decoys to mirror real responses.
    const body = [
      "1111111111111111111111111111111111111:5",
      `${suffix}:42`,
      "2222222222222222222222222222222222222:1",
    ].join("\r\n");

    const result = await checkBreachedPassword(
      password,
      mockFetchReturning(body)
    );
    expect(result.breached).toBe(true);
    expect(result.count).toBe(42);
  });

  it("reports not breached when the suffix is absent", async () => {
    const body = [
      "1111111111111111111111111111111111111:5",
      "2222222222222222222222222222222222222:1",
    ].join("\n");

    const result = await checkBreachedPassword(
      "definitely-not-in-any-breach-corpus-99",
      mockFetchReturning(body)
    );
    expect(result.breached).toBe(false);
    expect(result.unavailable).toBeUndefined();
  });

  it("fails open and flags `unavailable` when HIBP returns 5xx", async () => {
    const result = await checkBreachedPassword(
      "any-password",
      mockFetchReturning("", 503)
    );
    expect(result.breached).toBe(false);
    expect(result.unavailable).toBe(true);
  });

  it("fails open when fetch throws (network error)", async () => {
    const failingFetch = vi
      .fn()
      .mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const result = await checkBreachedPassword("any-password", failingFetch);
    expect(result.breached).toBe(false);
    expect(result.unavailable).toBe(true);
  });

  it("sends ONLY the first 5 hex chars of the SHA1 to HIBP (k-anonymity)", async () => {
    const password = "TestSecret123";
    const digest = sha1Upper(password);
    const expectedPrefix = digest.slice(0, 5);

    const captured: { url?: string } = {};
    const captureFetch = vi.fn().mockImplementation((url: string) => {
      captured.url = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof fetch;

    await checkBreachedPassword(password, captureFetch);
    expect(captured.url).toBe(
      `https://api.pwnedpasswords.com/range/${expectedPrefix}`
    );
    // Critical: full digest must NOT appear in the request URL.
    expect(captured.url).not.toContain(digest);
    expect(captured.url).not.toContain(digest.slice(5));
  });

  it("matches suffix case-insensitively (HIBP returns uppercase but be defensive)", async () => {
    const password = "WeakPass99";
    const digest = sha1Upper(password);
    const suffix = digest.slice(5);
    // Lowercased line — defensive: HIBP currently uses uppercase, but we
    // normalize.
    const body = `${suffix.toLowerCase()}:7`;

    const result = await checkBreachedPassword(password, mockFetchReturning(body));
    expect(result.breached).toBe(true);
    expect(result.count).toBe(7);
  });

  it("falls back to count=1 when the line's COUNT is not a finite number", async () => {
    // Covers the `Number.isFinite(count) ? count : 1` else branch.
    // Real HIBP rows are always digits, but corrupt/intercepted responses
    // could carry garbage and must not crash the auth path.
    const password = "BadCountPass";
    const digest = sha1Upper(password);
    const suffix = digest.slice(5);
    const body = `${suffix}:not-a-number`;

    const result = await checkBreachedPassword(password, mockFetchReturning(body));
    expect(result.breached).toBe(true);
    expect(result.count).toBe(1);
  });

  it("uses the global fetch when no fetchImpl is supplied", async () => {
    // Covers the default-parameter branch (`fetchImpl: typeof fetch = fetch`).
    const password = "GlobalFetchPass";
    const digest = sha1Upper(password);
    const suffix = digest.slice(5);
    const body = `${suffix}:9`;

    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const result = await checkBreachedPassword(password);
      expect(fetchSpy).toHaveBeenCalled();
      expect(result.breached).toBe(true);
      expect(result.count).toBe(9);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("opts out of HIBP padding via Add-Padding: false header", async () => {
    const captured: { headers?: HeadersInit } = {};
    const captureFetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        captured.headers = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(""),
        });
      }) as unknown as typeof fetch;

    await checkBreachedPassword("anything", captureFetch);
    const h = captured.headers as Record<string, string> | undefined;
    expect(h?.["Add-Padding"]).toBe("false");
  });
});
