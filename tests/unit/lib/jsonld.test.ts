import { describe, it, expect } from "vitest";
import {
  buildWebSiteSchema,
  buildOrganizationSchema,
  buildChannelSchema,
  buildMediaSchema,
  buildBreadcrumbSchema,
} from "@/lib/jsonld";

const config = {
  name: "TestStream",
  domain: "example.com",
  theme: { logo: "/logo.png" },
} as Parameters<typeof buildWebSiteSchema>[0];

const configNoLogo = {
  name: "TestStream",
  domain: "example.com",
  theme: {},
} as Parameters<typeof buildWebSiteSchema>[0];

describe("buildWebSiteSchema", () => {
  it("builds a valid WebSite schema", () => {
    const result = buildWebSiteSchema(config);
    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("WebSite");
    expect(result.name).toBe("TestStream");
    expect(result.url).toBe("https://example.com");
    expect(result.potentialAction).toBeDefined();
  });

  it("includes search action target", () => {
    const result = buildWebSiteSchema(config);
    const action = result.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("SearchAction");
    expect(action.target).toContain("search?q=");
  });
});

describe("buildOrganizationSchema", () => {
  it("builds organization with logo", () => {
    const result = buildOrganizationSchema(config);
    expect(result["@type"]).toBe("Organization");
    expect(result.name).toBe("TestStream");
    expect(result.logo).toBe("https://example.com/logo.png");
  });

  it("resolves absolute logo URL", () => {
    const extLogoConfig = {
      ...config,
      theme: { logo: "https://cdn.example.com/logo.png" },
    } as Parameters<typeof buildOrganizationSchema>[0];
    const result = buildOrganizationSchema(extLogoConfig);
    expect(result.logo).toBe("https://cdn.example.com/logo.png");
  });

  it("omits logo when not set", () => {
    const result = buildOrganizationSchema(configNoLogo);
    expect(result.logo).toBeUndefined();
  });
});

describe("buildChannelSchema", () => {
  const channel = {
    name: "My Channel",
    slug: "my-channel",
    bio: "A great channel",
    profileImageUrl: "https://cdn.example.com/avatar.jpg",
  };

  it("builds a CollectionPage schema", () => {
    const result = buildChannelSchema(channel, config);
    expect(result["@type"]).toBe("CollectionPage");
    expect(result.name).toBe("My Channel");
    expect(result.url).toBe("https://example.com/c/my-channel");
    expect(result.description).toBe("A great channel");
  });

  it("uses the bytea-backed URL when hasProfileImage is set", () => {
    const chWithId = { ...channel, id: "abc123", hasProfileImage: true };
    const result = buildChannelSchema(chWithId, config);
    expect(result.image).toBe("https://example.com/api/images/channel/abc123");
  });

  it("falls back to profileImageUrl", () => {
    const result = buildChannelSchema(channel, config);
    expect(result.image).toBe("https://cdn.example.com/avatar.jpg");
  });

  it("omits description and image when not present", () => {
    const minimal = { name: "Bare Channel", slug: "bare" };
    const result = buildChannelSchema(minimal, config);
    expect(result.description).toBeUndefined();
    expect(result.image).toBeUndefined();
  });

  it("includes parent website reference", () => {
    const result = buildChannelSchema(channel, config);
    const parent = result.isPartOf as Record<string, unknown>;
    expect(parent["@type"]).toBe("WebSite");
    expect(parent.name).toBe("TestStream");
  });
});

describe("buildMediaSchema", () => {
  const channel = { name: "Creator", slug: "creator" };

  const baseMedia = {
    id: "media123",
    name: "My Video",
    description: "A cool video",
    mediaType: "video" as const,
    thumbnailUrl: "https://cdn.example.com/thumb.jpg",
    createdAt: new Date("2025-01-15"),
    updatedAt: new Date("2025-01-16"),
  };

  it("builds VideoObject for video type", () => {
    const result = buildMediaSchema(baseMedia, channel, config);
    expect(result["@type"]).toBe("VideoObject");
    expect(result.name).toBe("My Video");
    expect(result.url).toBe("https://example.com/c/creator/media123");
  });

  it("builds AudioObject for audio type", () => {
    const media = { ...baseMedia, mediaType: "audio" as const };
    const result = buildMediaSchema(media, channel, config);
    expect(result["@type"]).toBe("AudioObject");
  });

  it("builds AudioObject for podcast type", () => {
    const media = { ...baseMedia, mediaType: "podcast" as const };
    const result = buildMediaSchema(media, channel, config);
    expect(result["@type"]).toBe("AudioObject");
  });

  it("builds Article for article type", () => {
    const media = { ...baseMedia, mediaType: "article" as const };
    const result = buildMediaSchema(media, channel, config);
    expect(result["@type"]).toBe("Article");
    expect(result.headline).toBe("My Video");
    const author = result.author as Record<string, unknown>;
    expect(author.name).toBe("Creator");
  });

  it("builds ImageObject for photo type", () => {
    const media = { ...baseMedia, mediaType: "photo" as const };
    const result = buildMediaSchema(media, channel, config);
    expect(result["@type"]).toBe("ImageObject");
  });

  it("falls back to CreativeWork for unknown type", () => {
    const media = { ...baseMedia, mediaType: "other" as never };
    const result = buildMediaSchema(media, channel, config);
    expect(result["@type"]).toBe("CreativeWork");
  });

  it("uses the bytea-backed URL when hasThumbnail is set", () => {
    const media = { ...baseMedia, hasThumbnail: true };
    const result = buildMediaSchema(media, channel, config);
    expect(result.thumbnailUrl).toBe("https://example.com/api/images/media-thumbnail/media123");
  });

  it("includes date fields", () => {
    const result = buildMediaSchema(baseMedia, channel, config);
    expect(result.datePublished).toBe("2025-01-15T00:00:00.000Z");
    expect(result.dateModified).toBe("2025-01-16T00:00:00.000Z");
  });

  it("omits optional fields when not present", () => {
    const minimal = {
      id: "m1",
      name: "Bare",
      mediaType: "video" as const,
    };
    const result = buildMediaSchema(minimal, channel, config);
    expect(result.description).toBeUndefined();
    expect(result.thumbnailUrl).toBeUndefined();
    expect(result.datePublished).toBeUndefined();
  });
});

describe("buildBreadcrumbSchema", () => {
  it("builds BreadcrumbList", () => {
    const items = [
      { name: "Home", url: "/" },
      { name: "Channel", url: "/c/test" },
    ];
    const result = buildBreadcrumbSchema(items, config);
    expect(result["@type"]).toBe("BreadcrumbList");
    const elements = result.itemListElement as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(2);
    expect(elements[0].position).toBe(1);
    expect(elements[0].item).toBe("https://example.com/");
    expect(elements[1].position).toBe(2);
    expect(elements[1].item).toBe("https://example.com/c/test");
  });

  it("handles absolute URLs", () => {
    const items = [{ name: "External", url: "https://other.com/page" }];
    const result = buildBreadcrumbSchema(items, config);
    const elements = result.itemListElement as Array<Record<string, unknown>>;
    expect(elements[0].item).toBe("https://other.com/page");
  });
});
