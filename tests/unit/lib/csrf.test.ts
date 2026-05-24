import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { checkOrigin } from "@/lib/csrf";

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL("https://example.com/api/x"), { headers });
}

describe("checkOrigin", () => {
  it("returns null when Host header is missing (cannot compare, allow)", async () => {
    // NextRequest strips Host on construction, but the underlying Headers can
    // omit it explicitly by passing no host-related keys. Build a request
    // whose `host` lookup returns null.
    const req = new NextRequest(new URL("https://example.com/api/x"));
    // Force-clear the host header by overriding the getter on a fresh Headers
    const stripped = new Headers();
    Object.defineProperty(req, "headers", { value: stripped, configurable: true });

    const result = checkOrigin(req);
    expect(result).toBeNull();
  });

  it("returns null when Origin matches Host (case-insensitive)", () => {
    const result = checkOrigin(
      request({ host: "Example.com", origin: "https://example.com" })
    );
    expect(result).toBeNull();
  });

  it("returns 403 on Origin/Host mismatch", () => {
    const res = checkOrigin(
      request({ host: "example.com", origin: "https://attacker.com" })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 403 when Origin header is not a valid URL", () => {
    const res = checkOrigin(
      request({ host: "example.com", origin: "not a url at all" })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns null when Referer matches Host (Origin absent)", () => {
    const result = checkOrigin(
      request({ host: "example.com", referer: "https://example.com/somewhere" })
    );
    expect(result).toBeNull();
  });

  it("returns 403 on Referer/Host mismatch (Origin absent)", () => {
    const res = checkOrigin(
      request({ host: "example.com", referer: "https://attacker.com/page" })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 403 when Referer header is not a valid URL (Origin absent)", () => {
    const res = checkOrigin(
      request({ host: "example.com", referer: "://broken" })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns null when both Origin and Referer are absent (server-to-server allowed)", () => {
    const result = checkOrigin(request({ host: "example.com" }));
    expect(result).toBeNull();
  });

  it("prefers Origin over Referer — Origin valid wins even if Referer mismatches", () => {
    // Per the function: when Origin is present, the Referer branch is not
    // consulted. So an attacker Referer + matching Origin still passes.
    const result = checkOrigin(
      request({
        host: "example.com",
        origin: "https://example.com",
        referer: "https://attacker.com/page",
      })
    );
    expect(result).toBeNull();
  });
});
