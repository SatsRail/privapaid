import { describe, it, expect } from "vitest";
import {
  normalizeSatsRailApiUrl,
  DEFAULT_SATSRAIL_API_URL,
} from "@/config/instance";

describe("normalizeSatsRailApiUrl", () => {
  it("defaults to the app host when unset", () => {
    expect(normalizeSatsRailApiUrl(undefined)).toBe(DEFAULT_SATSRAIL_API_URL);
    expect(normalizeSatsRailApiUrl(null)).toBe(DEFAULT_SATSRAIL_API_URL);
    expect(normalizeSatsRailApiUrl("")).toBe(DEFAULT_SATSRAIL_API_URL);
    expect(normalizeSatsRailApiUrl("   ")).toBe(DEFAULT_SATSRAIL_API_URL);
  });

  it("points the default at app.satsrail.com", () => {
    expect(DEFAULT_SATSRAIL_API_URL).toBe("https://app.satsrail.com/api/v1");
  });

  // The apex satsrail.com has no DNS record at all — shipping it in the
  // example env files meant requests failed to resolve before leaving the box.
  it("rewrites the legacy apex host onto the API host", () => {
    expect(normalizeSatsRailApiUrl("https://satsrail.com/api/v1")).toBe(
      "https://app.satsrail.com/api/v1"
    );
  });

  it("rewrites the www marketing host onto the API host", () => {
    expect(normalizeSatsRailApiUrl("https://www.satsrail.com/api/v1")).toBe(
      "https://app.satsrail.com/api/v1"
    );
  });

  it("supplies the /api/v1 prefix when the URL is a bare origin", () => {
    expect(normalizeSatsRailApiUrl("https://app.satsrail.com")).toBe(
      "https://app.satsrail.com/api/v1"
    );
    expect(normalizeSatsRailApiUrl("https://app.satsrail.com/")).toBe(
      "https://app.satsrail.com/api/v1"
    );
  });

  it("trims surrounding whitespace and trailing slashes", () => {
    expect(normalizeSatsRailApiUrl("  https://app.satsrail.com/api/v1/  ")).toBe(
      "https://app.satsrail.com/api/v1"
    );
  });

  it("leaves an already-correct URL untouched", () => {
    expect(normalizeSatsRailApiUrl("https://app.satsrail.com/api/v1")).toBe(
      "https://app.satsrail.com/api/v1"
    );
  });

  it("leaves self-hosted portals alone, including host, port and path", () => {
    expect(normalizeSatsRailApiUrl("https://portal.example.com/api/v1")).toBe(
      "https://portal.example.com/api/v1"
    );
    expect(normalizeSatsRailApiUrl("http://localhost:3001/api/v2")).toBe(
      "http://localhost:3001/api/v2"
    );
    expect(normalizeSatsRailApiUrl("https://staging.satsrail.com/api/v1")).toBe(
      "https://staging.satsrail.com/api/v1"
    );
  });

  it("falls back to the default for an unparseable value", () => {
    expect(normalizeSatsRailApiUrl("not a url")).toBe(DEFAULT_SATSRAIL_API_URL);
  });
});
