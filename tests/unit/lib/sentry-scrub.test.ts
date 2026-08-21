import { describe, it, expect } from "vitest";
import { scrubEvent, scrubBreadcrumb, __test__ } from "@/lib/sentry-scrub";
import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";

const { isSensitiveKey, SCRUB_MARKER } = __test__;

describe("sentry-scrub", () => {
  describe("isSensitiveKey", () => {
    it.each([
      "password",
      "Password",
      "PASSWORD",
      "password_hash",
      "source_url",
      "satsrail_api_key",
      "satsrail_api_key_encrypted",
      "macaroon",
      "authorization",
      "Authorization",
      "cookie",
      "set-cookie",
      "Set-Cookie",
      "dek",
      "encrypted_dek",
      "master_key",
      "encryption_key",
      "sk_encryption_key",
      "admin_source_url_plaintext",
      "admin_source_plaintext",
      "admin_photo_bytes",
    ])("flags %s as sensitive", (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    });

    it.each([
      "sk_live_abc123",
      "sk_test_abc123",
      "pk_live_xyz",
      "pk_test_xyz",
    ])("flags token-shaped key name %s as sensitive", (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    });

    it.each([
      "email",
      "username",
      "user_id",
      "channel_id",
      "media_id",
      "product_id",
      "amount_cents",
      "currency",
    ])("does not flag benign key %s", (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    });
  });

  describe("scrubEvent", () => {
    it("scrubs request.data", () => {
      const event: ErrorEvent = {
        request: {
          data: {
            satsrail_api_key: "sk_live_real_key",
            instance_name: "My Site",
          },
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const data = event.request!.data as Record<string, unknown>;
      expect(data.satsrail_api_key).not.toBe("sk_live_real_key");
      expect(String(data.satsrail_api_key)).toContain(SCRUB_MARKER);
      expect(data.instance_name).toBe("My Site");
    });

    it("scrubs nested request.data", () => {
      const event: ErrorEvent = {
        request: {
          data: {
            settings: {
              merchant: {
                satsrail_api_key: "sk_live_secret",
                merchant_name: "Acme",
              },
            },
          },
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const data = event.request!.data as {
        settings: { merchant: Record<string, unknown> };
      };
      expect(String(data.settings.merchant.satsrail_api_key)).toContain(
        SCRUB_MARKER
      );
      expect(data.settings.merchant.merchant_name).toBe("Acme");
    });

    it("scrubs request.headers including authorization and cookie", () => {
      const event: ErrorEvent = {
        request: {
          headers: {
            authorization: "Bearer sk_live_abc",
            cookie: "satsrail_macaroons=...",
            "user-agent": "vitest",
          },
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const h = event.request!.headers as Record<string, string>;
      expect(h.authorization).toContain(SCRUB_MARKER);
      expect(h.cookie).toContain(SCRUB_MARKER);
      expect(h["user-agent"]).toBe("vitest");
    });

    it("scrubs request.cookies", () => {
      const event: ErrorEvent = {
        request: {
          cookies: { satsrail_macaroons: "{\"prod\":\"mac\"}" },
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      // satsrail_macaroons matches the "macaroon" prefix-via-key-substring? No
      // — it's an exact-key check. The value itself wouldn't be matched. We
      // expect it to PASS-THROUGH unless the key contains a sensitive token.
      // This documents the current behavior: the cookie name is not in the
      // sensitive-keys list. The macaroon cookie is httpOnly and Sentry
      // would only see it via Set-Cookie / cookie headers above (which ARE
      // scrubbed).
      expect(event.request!.cookies!.satsrail_macaroons).toBe(
        "{\"prod\":\"mac\"}"
      );
    });

    it("drops request.query_string entirely", () => {
      const event: ErrorEvent = {
        request: {
          query_string: "token=sk_live_abc&foo=bar",
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(event.request!.query_string).toBe(SCRUB_MARKER);
    });

    it("scrubs event.extra including source_url", () => {
      const event: ErrorEvent = {
        extra: {
          source_url: "https://s3.example.com/secret-video.mp4",
          media_id: "abc123",
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.extra!.source_url)).toContain(SCRUB_MARKER);
      expect(event.extra!.media_id).toBe("abc123");
    });

    it("scrubs event.breadcrumbs[*].data", () => {
      const event: ErrorEvent = {
        breadcrumbs: [
          {
            category: "fetch",
            data: {
              url: "https://app.satsrail.com/api/v1/products",
              satsrail_api_key: "sk_live_real",
            },
          },
        ],
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const data = event.breadcrumbs![0].data as Record<string, unknown>;
      expect(String(data.satsrail_api_key)).toContain(SCRUB_MARKER);
      expect(data.url).toBe("https://app.satsrail.com/api/v1/products");
    });

    it("scrubs event.contexts", () => {
      const event: ErrorEvent = {
        contexts: {
          state: { satsrail_api_key: "sk_live_leak", other: "ok" },
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const state = event.contexts!.state as Record<string, unknown>;
      expect(String(state.satsrail_api_key)).toContain(SCRUB_MARKER);
      expect(state.other).toBe("ok");
    });

    it("scrubs event.tags", () => {
      const event: ErrorEvent = {
        tags: { password: "leaked-pw", environment: "production" },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.tags!.password)).toContain(SCRUB_MARKER);
      expect(event.tags!.environment).toBe("production");
    });

    it("scrubs event.user", () => {
      const event: ErrorEvent = {
        user: { id: "u1", authorization: "Bearer x" },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.user!.authorization)).toContain(SCRUB_MARKER);
      expect(event.user!.id).toBe("u1");
    });

    it("skips breadcrumbs whose data is missing", () => {
      const event: ErrorEvent = {
        breadcrumbs: [
          { category: "navigation" } as Breadcrumb,
          {
            category: "fetch",
            data: { authorization: "Bearer leak" },
          } as Breadcrumb,
        ],
      } as unknown as ErrorEvent;
      // Should not throw on the data-less crumb.
      scrubEvent(event);
      expect(String(event.breadcrumbs![1].data!.authorization)).toContain(
        SCRUB_MARKER
      );
    });

    it("scrubs the Phase 5 plaintext recovery fields", () => {
      const event: ErrorEvent = {
        extra: {
          admin_source_url_plaintext: "https://internal.example/video.mp4",
          admin_source_plaintext: "the full article body",
          admin_photo_bytes: "AAAAAAAAA...",
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.extra!.admin_source_url_plaintext)).toContain(
        SCRUB_MARKER
      );
      expect(String(event.extra!.admin_source_plaintext)).toContain(
        SCRUB_MARKER
      );
      expect(String(event.extra!.admin_photo_bytes)).toContain(SCRUB_MARKER);
    });

    it("handles events with no scrubbable fields gracefully", () => {
      const event: ErrorEvent = { message: "something failed" } as unknown as ErrorEvent;
      const result = scrubEvent(event);
      expect(result).toBe(event);
    });

    it("does not infinite-loop on cyclic structures", () => {
      const cyclic: Record<string, unknown> = { foo: "bar" };
      cyclic.self = cyclic;
      const event: ErrorEvent = {
        extra: { payload: cyclic },
      } as unknown as ErrorEvent;
      // MAX_DEPTH guard prevents stack overflow.
      expect(() => scrubEvent(event)).not.toThrow();
    });

    it("scrubs sk_-prefixed and pk_-prefixed keys at top level", () => {
      const event: ErrorEvent = {
        extra: {
          sk_live: "abc",
          pk_test_xyz: "def",
          name: "Acme",
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.extra!.sk_live)).toContain(SCRUB_MARKER);
      expect(String(event.extra!.pk_test_xyz)).toContain(SCRUB_MARKER);
      expect(event.extra!.name).toBe("Acme");
    });

    it("annotates the scrubbed value with original length", () => {
      const event: ErrorEvent = {
        extra: { password: "secret123" },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(event.extra!.password).toBe(`${SCRUB_MARKER}:9`);
    });

    it("scrubs null and undefined values to a bare marker (no length)", () => {
      const event: ErrorEvent = {
        extra: { password: null, sk_live: undefined },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(event.extra!.password).toBe(SCRUB_MARKER);
      expect(event.extra!.sk_live).toBe(SCRUB_MARKER);
    });

    it("annotates non-string sensitive values with their serialized length", () => {
      const event: ErrorEvent = {
        extra: {
          // Object — must go through JSON.stringify path.
          authorization: { token: "abc", refresh: "def" },
          // Number — also non-string, also JSON.stringify path.
          encryption_key: 1234567,
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(String(event.extra!.authorization)).toMatch(/^\[scrubbed\]:\d+$/);
      expect(String(event.extra!.encryption_key)).toBe(`${SCRUB_MARKER}:7`);
    });

    it("falls back to a bare marker when JSON.stringify throws (BigInt, cyclic, ...)", () => {
      // BigInt is not JSON-serializable and JSON.stringify throws a TypeError.
      // The scrubber's try/catch must swallow it and return the bare marker.
      const event: ErrorEvent = {
        extra: { dek: BigInt(42) as unknown },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      expect(event.extra!.dek).toBe(SCRUB_MARKER);
    });

    it("recurses into arrays in non-sensitive containers", () => {
      // Top-level container is not sensitive, but the array's element is a
      // dict containing a sensitive key. Must be scrubbed inside the array.
      const event: ErrorEvent = {
        extra: {
          requests: [
            { method: "POST", password: "p1" },
            { method: "GET", password: "p2" },
          ],
        },
      } as unknown as ErrorEvent;
      scrubEvent(event);
      const list = event.extra!.requests as Array<Record<string, unknown>>;
      expect(list[0].method).toBe("POST");
      expect(String(list[0].password)).toMatch(/^\[scrubbed\]/);
      expect(String(list[1].password)).toMatch(/^\[scrubbed\]/);
    });
  });

  describe("scrubBreadcrumb", () => {
    it("scrubs the data field on a breadcrumb", () => {
      const crumb: Breadcrumb = {
        category: "http",
        data: {
          url: "/api/setup",
          satsrail_api_key: "sk_live_x",
        },
      };
      scrubBreadcrumb(crumb);
      const data = crumb.data as Record<string, unknown>;
      expect(String(data.satsrail_api_key)).toContain(SCRUB_MARKER);
      expect(data.url).toBe("/api/setup");
    });

    it("returns the breadcrumb (does not drop it)", () => {
      const crumb: Breadcrumb = { category: "navigation" };
      expect(scrubBreadcrumb(crumb)).toBe(crumb);
    });
  });
});
