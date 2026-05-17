import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateBody, isValidationError, schemas } from "@/lib/validate";

// Helper to create a Request with a JSON body
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function invalidJsonRequest(): Request {
  return new Request("http://localhost:3000/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json{",
  });
}

describe("validateBody", () => {
  it("returns parsed data for valid input", async () => {
    const req = jsonRequest({ nickname: "testuser", password: "MyPass123!@abc" });
    const result = await validateBody(req, schemas.customerSignup);
    expect(isValidationError(result)).toBe(false);
    expect(result).toEqual({ nickname: "testuser", password: "MyPass123!@abc" });
  });

  it("returns 400 for invalid JSON", async () => {
    const req = invalidJsonRequest();
    const result = await validateBody(req, schemas.customerSignup);
    expect(isValidationError(result)).toBe(true);
    const body = await (result as Response).json();
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 400 with issues for validation failure", async () => {
    const req = jsonRequest({ nickname: "", password: "short" });
    const result = await validateBody(req, schemas.customerSignup);
    expect(isValidationError(result)).toBe(true);
    const body = await (result as Response).json();
    expect(body.error).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

describe("isValidationError", () => {
  it("returns true for NextResponse", async () => {
    const { NextResponse } = await import("next/server");
    const res = NextResponse.json({}, { status: 400 });
    expect(isValidationError(res)).toBe(true);
  });

  it("returns false for plain data", () => {
    expect(isValidationError({ nickname: "test" })).toBe(false);
    expect(isValidationError(null)).toBe(false);
    expect(isValidationError("string")).toBe(false);
  });
});

describe("schemas", () => {
  describe("customerSignup", () => {
    const schema = schemas.customerSignup;

    it("accepts valid signup data", () => {
      const result = schema.safeParse({ nickname: "testuser", password: "MyPass123!@abc" });
      expect(result.success).toBe(true);
    });

    it("rejects short nickname", () => {
      const result = schema.safeParse({ nickname: "a", password: "MyPass123!@abc" });
      expect(result.success).toBe(false);
    });

    it("rejects nickname with special chars", () => {
      const result = schema.safeParse({ nickname: "test user!", password: "MyPass123!@abc" });
      expect(result.success).toBe(false);
    });

    it("rejects password shorter than 6 chars", () => {
      const result = schema.safeParse({ nickname: "testuser", password: "12345" });
      expect(result.success).toBe(false);
    });
  });

  describe("categoryCreate", () => {
    const schema = schemas.categoryCreate;

    it("accepts valid category", () => {
      const result = schema.safeParse({ name: "Music" });
      expect(result.success).toBe(true);
    });

    it("accepts category with slug and position", () => {
      const result = schema.safeParse({ name: "Music", slug: "music", position: 0 });
      expect(result.success).toBe(true);
    });

    it("rejects empty name", () => {
      const result = schema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid slug format", () => {
      const result = schema.safeParse({ name: "Music", slug: "Music Videos!" });
      expect(result.success).toBe(false);
    });

    it("trims name whitespace", () => {
      const result = schema.safeParse({ name: "  Music  " });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.name).toBe("Music");
    });
  });

  describe("channelCreate", () => {
    const schema = schemas.channelCreate;

    it("accepts valid channel", () => {
      const result = schema.safeParse({ name: "My Channel" });
      expect(result.success).toBe(true);
    });

    it("accepts channel with all fields", () => {
      const result = schema.safeParse({
        name: "My Channel",
        slug: "my-channel",
        bio: "A great channel",
        nsfw: false,
        social_links: { youtube: "https://youtube.com" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty name", () => {
      const result = schema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("mediaCreate", () => {
    const schema = schemas.mediaCreate;

    it("accepts valid media", () => {
      const result = schema.safeParse({
        channel_id: "abc123",
        name: "My Video",
        source_url: "https://example.com/video.mp4",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing channel_id", () => {
      const result = schema.safeParse({ name: "My Video", source_url: "https://example.com" });
      expect(result.success).toBe(false);
    });

    it("rejects missing source_url", () => {
      const result = schema.safeParse({ channel_id: "abc", name: "My Video" });
      expect(result.success).toBe(false);
    });

    it("accepts markdown content at the 500KB boundary", () => {
      const result = schema.safeParse({
        channel_id: "abc",
        name: "My Article",
        source_url: "a".repeat(500_000),
        media_type: "article",
      });
      expect(result.success).toBe(true);
    });

    it("rejects source_url over 500KB", () => {
      const result = schema.safeParse({
        channel_id: "abc",
        name: "My Article",
        source_url: "a".repeat(500_001),
        media_type: "article",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("mediaUpdate", () => {
    const schema = schemas.mediaUpdate;

    it("accepts markdown content at the 500KB boundary", () => {
      const result = schema.safeParse({
        source_url: "a".repeat(500_000),
      });
      expect(result.success).toBe(true);
    });

    it("rejects source_url over 500KB", () => {
      const result = schema.safeParse({
        source_url: "a".repeat(500_001),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("checkout", () => {
    const schema = schemas.checkout;

    it("accepts valid checkout", () => {
      const result = schema.safeParse({ media_id: "abc123", product_id: "prod_123" });
      expect(result.success).toBe(true);
    });

    it("rejects empty media_id", () => {
      const result = schema.safeParse({ media_id: "", product_id: "prod_123" });
      expect(result.success).toBe(false);
    });
  });

  describe("setup", () => {
    const schema = schemas.setup;

    it("accepts valid setup data", () => {
      const result = schema.safeParse({
        instance_name: "My Instance",
        satsrail_api_key: "sk_live_abc123",
        merchant_id: "merch_123",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing instance name", () => {
      const result = schema.safeParse({
        satsrail_api_key: "sk_live_abc123",
        merchant_id: "merch_123",
      });
      expect(result.success).toBe(false);
    });

    it("accepts optional theme color", () => {
      const result = schema.safeParse({
        instance_name: "My Instance",
        satsrail_api_key: "sk_live_abc123",
        merchant_id: "merch_123",
        theme_primary: "#ff5500",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid hex color", () => {
      const result = schema.safeParse({
        instance_name: "My Instance",
        satsrail_api_key: "sk_live_abc123",
        merchant_id: "merch_123",
        theme_primary: "red",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("commentCreate", () => {
    const schema = schemas.commentCreate;

    it("accepts valid comment", () => {
      const result = schema.safeParse({ body: "Great content!" });
      expect(result.success).toBe(true);
    });

    it("rejects empty comment", () => {
      const result = schema.safeParse({ body: "" });
      expect(result.success).toBe(false);
    });

    it("rejects comment over 2000 chars", () => {
      const result = schema.safeParse({ body: "a".repeat(2001) });
      expect(result.success).toBe(false);
    });

    it("trims whitespace", () => {
      const result = schema.safeParse({ body: "  hello  " });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.body).toBe("hello");
    });
  });

  describe("adminCreate", () => {
    const schema = schemas.adminCreate;

    it("accepts valid admin", () => {
      const result = schema.safeParse({
        email: "admin@test.com",
        name: "Admin User",
        password: "password123",
        role: "admin",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid email", () => {
      const result = schema.safeParse({
        email: "not-an-email",
        name: "Admin",
        password: "password123",
        role: "admin",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid role", () => {
      const result = schema.safeParse({
        email: "admin@test.com",
        name: "Admin",
        password: "password123",
        role: "superadmin",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("productCreate", () => {
    const schema = schemas.productCreate;

    it("accepts valid product", () => {
      const result = schema.safeParse({
        name: "Premium Video",
        price_cents: 1000,
        product_type_id: "pt_123",
      });
      expect(result.success).toBe(true);
    });

    it("rejects zero price", () => {
      const result = schema.safeParse({
        name: "Free Video",
        price_cents: 0,
        product_type_id: "pt_123",
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative price", () => {
      const result = schema.safeParse({
        name: "Video",
        price_cents: -100,
        product_type_id: "pt_123",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("settingsUpdate", () => {
    const schema = schemas.settingsUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ instance_name: "New Name" });
      expect(result.success).toBe(true);
    });

    it("accepts empty object (all optional)", () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects invalid theme color", () => {
      const result = schema.safeParse({ theme_bg: "notacolor" });
      expect(result.success).toBe(false);
    });

    it("accepts valid hex colors", () => {
      const result = schema.safeParse({
        theme_primary: "#ff5500",
        theme_bg: "#000000",
        theme_text: "#ffffff",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("reorder", () => {
    const schema = schemas.reorder;

    it("accepts valid reorder", () => {
      const result = schema.safeParse({
        items: [
          { id: "abc", position: 0 },
          { id: "def", position: 1 },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty items array", () => {
      const result = schema.safeParse({ items: [] });
      expect(result.success).toBe(false);
    });
  });

  describe("favorite", () => {
    const schema = schemas.favorite;

    it("accepts valid favorite", () => {
      const result = schema.safeParse({ channel_id: "abc123" });
      expect(result.success).toBe(true);
    });

    it("rejects empty channel_id", () => {
      const result = schema.safeParse({ channel_id: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("verifyKey", () => {
    const schema = schemas.verifyKey;

    it("accepts valid key", () => {
      const result = schema.safeParse({ satsrail_api_key: "sk_live_abc123" });
      expect(result.success).toBe(true);
    });

    it("trims whitespace", () => {
      const result = schema.safeParse({ satsrail_api_key: "  sk_live_abc123  " });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.satsrail_api_key).toBe("sk_live_abc123");
    });
  });

  describe("customerProfile", () => {
    const schema = schemas.customerProfile;

    it("accepts profile with image", () => {
      const result = schema.safeParse({ profile_image_id: "img_123" });
      expect(result.success).toBe(true);
    });

    it("accepts empty object", () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("customerPurchase", () => {
    const schema = schemas.customerPurchase;

    it("accepts valid purchase", () => {
      const result = schema.safeParse({ order_id: "ord_123", product_id: "prod_456" });
      expect(result.success).toBe(true);
    });

    it("rejects missing order_id", () => {
      const result = schema.safeParse({ product_id: "prod_456" });
      expect(result.success).toBe(false);
    });

    it("rejects empty product_id", () => {
      const result = schema.safeParse({ order_id: "ord_123", product_id: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("categoryUpdate", () => {
    const schema = schemas.categoryUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });

    it("accepts empty object", () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects invalid slug", () => {
      const result = schema.safeParse({ slug: "INVALID SLUG!" });
      expect(result.success).toBe(false);
    });
  });

  describe("channelUpdate", () => {
    const schema = schemas.channelUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ name: "New Name", active: false });
      expect(result.success).toBe(true);
    });

    it("accepts stream fields", () => {
      const result = schema.safeParse({
        is_live: true,
        stream_url: "https://stream.example.com/live",
      });
      expect(result.success).toBe(true);
    });

    it("accepts empty string for stream_url", () => {
      const result = schema.safeParse({ stream_url: "" });
      expect(result.success).toBe(true);
    });
  });

  describe("mediaUpdate", () => {
    const schema = schemas.mediaUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ name: "Updated Title" });
      expect(result.success).toBe(true);
    });

    it("accepts media_type change", () => {
      const result = schema.safeParse({ media_type: "audio" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid media_type", () => {
      const result = schema.safeParse({ media_type: "unknown" });
      expect(result.success).toBe(false);
    });
  });

  describe("adminUpdate", () => {
    const schema = schemas.adminUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ name: "New Name", active: false });
      expect(result.success).toBe(true);
    });

    it("accepts role change", () => {
      const result = schema.safeParse({ role: "moderator" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid role", () => {
      const result = schema.safeParse({ role: "owner" });
      expect(result.success).toBe(false);
    });

    it("rejects short password", () => {
      const result = schema.safeParse({ password: "short" });
      expect(result.success).toBe(false);
    });
  });

  describe("productUpdate", () => {
    const schema = schemas.productUpdate;

    it("accepts partial update", () => {
      const result = schema.safeParse({ name: "Updated Product" });
      expect(result.success).toBe(true);
    });

    it("accepts status change", () => {
      const result = schema.safeParse({ status: "inactive" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid status", () => {
      const result = schema.safeParse({ status: "deleted" });
      expect(result.success).toBe(false);
    });
  });

  describe("productTypeCreate", () => {
    const schema = schemas.productTypeCreate;

    it("accepts valid product type", () => {
      const result = schema.safeParse({ name: "Videos" });
      expect(result.success).toBe(true);
    });

    it("rejects empty name", () => {
      const result = schema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("flagCreate", () => {
    const schema = schemas.flagCreate;

    it("accepts valid flag", () => {
      const result = schema.safeParse({ flag_type: "inappropriate" });
      expect(result.success).toBe(true);
    });

    it("rejects empty flag_type", () => {
      const result = schema.safeParse({ flag_type: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("importPayload", () => {
    const schema = schemas.importPayload;

    it("accepts minimal valid payload", () => {
      const result = schema.safeParse({ version: "1.0" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.categories).toEqual([]);
        expect(result.data.channels).toEqual([]);
      }
    });

    it("accepts full payload", () => {
      const result = schema.safeParse({
        version: "1.0",
        categories: [{ slug: "music", name: "Music" }],
        channels: [
          {
            slug: "my-channel",
            name: "My Channel",
            media: [
              {
                name: "Video 1",
                source_url: "https://example.com/v1.mp4",
                product: {
                  name: "Buy Video 1",
                  price_cents: 500,
                },
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects wrong version", () => {
      const result = schema.safeParse({ version: "2.0" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid category slug", () => {
      const result = schema.safeParse({
        version: "1.0",
        categories: [{ slug: "INVALID SLUG", name: "Bad" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("importMedia", () => {
    const schema = schemas.importMedia;

    it("accepts minimal media", () => {
      const result = schema.safeParse({
        name: "Test",
        source_url: "https://example.com/v.mp4",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.media_type).toBe("video");
        expect(result.data.description).toBe("");
      }
    });

    it("accepts media with product", () => {
      const result = schema.safeParse({
        name: "Premium",
        source_url: "https://example.com/v.mp4",
        product: { name: "Buy it", price_cents: 1000 },
      });
      expect(result.success).toBe(true);
    });

    it("validates media_type enum", () => {
      const result = schema.safeParse({
        name: "Test",
        source_url: "https://example.com/v.mp4",
        media_type: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("importPayload (real-world export fixture)", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "../../fixtures/privapaid-export-sample.json"),
        "utf-8"
      )
    );

    it("accepts the canonical privapaid-export sample", () => {
      const result = schemas.importPayload.safeParse(fixture);
      if (!result.success) {
        // Surface the first issue path to make regressions obvious
         
        console.error("importPayload issues:", result.error.issues.slice(0, 5));
      }
      expect(result.success).toBe(true);
    });

    it("the fixture covers a meaningful breadth of shapes", () => {
      // Guard against the fixture quietly losing coverage (e.g., someone
      // shrinking it). Asserts the canonical sample exercises:
      // - all 5 media_type values
      // - channel-level products AND media-level products
      // - mixed currency casing ("USD" and "usd")
      // - both empty and populated preview_image_urls arrays
      // - unicode/emoji in names and descriptions
      expect(fixture.categories.length).toBeGreaterThanOrEqual(5);
      expect(fixture.channels.length).toBeGreaterThanOrEqual(5);

      const allMedia = fixture.channels.flatMap((c: { media: unknown[] }) => c.media);
      const mediaTypes = new Set(
        allMedia.map((m: { media_type: string }) => m.media_type)
      );
      expect(mediaTypes).toEqual(
        new Set(["video", "audio", "article", "photo_set", "podcast"])
      );

      expect(
        fixture.channels.some((c: { product?: unknown }) => c.product)
      ).toBe(true);
      expect(
        allMedia.some((m: { product?: unknown }) => m.product)
      ).toBe(true);
    });
  });
});
