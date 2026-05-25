import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";
import { createChannel, createMedia } from "../../helpers/factories";
import { prisma } from "@/lib/prisma";

// Hoisted mock state so the vi.mock factory can read it at module-init time
// without TDZ issues. Test cases mutate `mockConfig` to flip nsfw on a
// per-case basis.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    domain: "test.example.com",
    nsfw: false,
    locale: "en",
  },
}));

vi.mock("@/config/instance", () => ({
  getInstanceConfig: vi.fn(async () => ({
    name: "Test Instance",
    domain: mockConfig.domain,
    nsfw: mockConfig.nsfw,
    locale: mockConfig.locale,
  })),
}));

import { GET } from "@/app/c/[slug]/feed.xml/route";

function feedRequest(slug: string): [Request, { params: Promise<{ slug: string }> }] {
  const req = new Request(`http://localhost:3000/c/${slug}/feed.xml`);
  return [req, { params: Promise.resolve({ slug }) }];
}

// Helper to set createdAt on a media row (Prisma blocks setting @default(now())
// fields directly via the regular API).
async function setMediaCreatedAt(id: string, when: Date) {
  await prisma.$executeRaw`UPDATE "Media" SET "createdAt" = ${when.toISOString()}::timestamp WHERE id = ${id}`;
}

describe("GET /c/[slug]/feed.xml", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
    // Reset NSFW gate between cases.
    mockConfig.nsfw = false;
    mockConfig.locale = "en";
  });

  describe("404 branches", () => {
    it("returns 404 when the channel slug doesn't exist", async () => {
      const res = await GET(...feedRequest("does-not-exist"));
      expect(res.status).toBe(404);
    });

    it("returns 404 for an inactive channel", async () => {
      const ch = await createChannel({ slug: "hidden", active: false });
      await createMedia(ch.id);
      const res = await GET(...feedRequest("hidden"));
      expect(res.status).toBe(404);
    });

    it("returns 404 for a soft-deleted channel", async () => {
      const ch = await createChannel({ slug: "tombstoned" });
      await prisma.channel.update({ where: { id: ch.id }, data: { deletedAt: new Date() } });
      await createMedia(ch.id);
      const res = await GET(...feedRequest("tombstoned"));
      expect(res.status).toBe(404);
    });

    it("returns 404 for an NSFW channel when instance NSFW is disabled", async () => {
      mockConfig.nsfw = false;
      await createChannel({ slug: "adult", nsfw: true });
      const res = await GET(...feedRequest("adult"));
      expect(res.status).toBe(404);
    });
  });

  describe("200 branches", () => {
    it("returns 200 with correct headers for an active channel with media", async () => {
      const ch = await createChannel({ slug: "good", name: "Good Channel" });
      await createMedia(ch.id, { name: "First Video" });

      const res = await GET(...feedRequest("good"));

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/rss+xml; charset=utf-8"
      );
      expect(res.headers.get("cache-control")).toBe(
        "public, s-maxage=300, stale-while-revalidate=600"
      );
    });

    it("returns 200 for an NSFW channel when instance NSFW is enabled", async () => {
      mockConfig.nsfw = true;
      await createChannel({ slug: "adult-allowed", nsfw: true });
      const res = await GET(...feedRequest("adult-allowed"));
      expect(res.status).toBe(200);
    });
  });

  describe("body content", () => {
    it("renders channel name, bio, and self-link in the RSS envelope", async () => {
      await createChannel({
        slug: "envelope",
        name: "Envelope Channel",
        bio: "A bio about the channel",
      });

      const res = await GET(...feedRequest("envelope"));
      const body = await res.text();

      expect(body).toContain("<title>Envelope Channel</title>");
      expect(body).toContain("<description>A bio about the channel</description>");
      expect(body).toContain("<link>https://test.example.com/c/envelope</link>");
      // atom:self link points back at the feed URL.
      expect(body).toContain(
        '<atom:link href="https://test.example.com/c/envelope/feed.xml" rel="self" type="application/rss+xml" />'
      );
      // RSS 2.0 root with atom namespace.
      expect(body).toMatch(/<rss version="2.0" xmlns:atom="http:\/\/www.w3.org\/2005\/Atom">/);
    });

    it("uses the instance locale for <language>", async () => {
      mockConfig.locale = "es";
      await createChannel({ slug: "spanish", name: "ES" });
      const res = await GET(...feedRequest("spanish"));
      const body = await res.text();
      expect(body).toContain("<language>es</language>");
    });

    it("orders items by createdAt desc (newest first)", async () => {
      const ch = await createChannel({ slug: "ordered" });
      const oldest = await createMedia(ch.id, { name: "Oldest" });
      const newest = await createMedia(ch.id, { name: "Newest" });
      const middle = await createMedia(ch.id, { name: "Middle" });
      await setMediaCreatedAt(oldest.id, new Date("2026-01-01T00:00:00Z"));
      await setMediaCreatedAt(newest.id, new Date("2026-03-01T00:00:00Z"));
      await setMediaCreatedAt(middle.id, new Date("2026-02-01T00:00:00Z"));

      const res = await GET(...feedRequest("ordered"));
      const body = await res.text();
      const newestIdx = body.indexOf("Newest");
      const middleIdx = body.indexOf("Middle");
      const oldestIdx = body.indexOf("Oldest");

      expect(newestIdx).toBeGreaterThan(-1);
      expect(middleIdx).toBeGreaterThan(newestIdx);
      expect(oldestIdx).toBeGreaterThan(middleIdx);
    });

    it("excludes soft-deleted media items", async () => {
      const ch = await createChannel({ slug: "with-deletes" });
      await createMedia(ch.id, { name: "Visible" });
      const sd = await createMedia(ch.id, { name: "Soft Deleted" });
      await prisma.media.update({ where: { id: sd.id }, data: { deletedAt: new Date() } });

      const res = await GET(...feedRequest("with-deletes"));
      const body = await res.text();

      expect(body).toContain("<title>Visible</title>");
      expect(body).not.toContain("<title>Soft Deleted</title>");
    });

    it("caps the feed at 50 items", async () => {
      const ch = await createChannel({ slug: "many-items" });
      const base = Date.now();
      for (let i = 0; i < 55; i++) {
        const m = await createMedia(ch.id, { name: `Item ${i.toString().padStart(2, "0")}` });
        await setMediaCreatedAt(m.id, new Date(base - i * 1000));
      }

      const res = await GET(...feedRequest("many-items"));
      const body = await res.text();
      const itemMatches = body.match(/<item>/g) ?? [];
      expect(itemMatches.length).toBe(50);
    });

    it("escapes XML special characters in name and description", async () => {
      const ch = await createChannel({ slug: "escapes" });
      await createMedia(ch.id, {
        name: "Tom & Jerry <eats> \"cheese\"",
        description: "if x > y && y < z then 'ok'",
      });

      const res = await GET(...feedRequest("escapes"));
      const body = await res.text();

      // Raw special characters must not appear as title content.
      expect(body).toContain(
        "<title>Tom &amp; Jerry &lt;eats&gt; &quot;cheese&quot;</title>"
      );
      // Description is wrapped in CDATA and includes escaped HTML inside.
      expect(body).toContain("if x &gt; y &amp;&amp; y &lt; z then &apos;ok&apos;");
    });

    it("emits pubDate in RFC 822 format", async () => {
      const ch = await createChannel({ slug: "dates" });
      const m = await createMedia(ch.id, { name: "Dated" });
      await setMediaCreatedAt(m.id, new Date("2026-03-21T16:37:22.000Z"));

      const res = await GET(...feedRequest("dates"));
      const body = await res.text();
      // toUTCString format: "Sat, 21 Mar 2026 16:37:22 GMT"
      expect(body).toContain("<pubDate>Sat, 21 Mar 2026 16:37:22 GMT</pubDate>");
    });

    it("links items to /c/{slug}/{mediaId} as both <link> and <guid>", async () => {
      const ch = await createChannel({ slug: "links" });
      const media = await createMedia(ch.id, { name: "L" });
      const itemUrl = `https://test.example.com/c/links/${media.id}`;

      const res = await GET(...feedRequest("links"));
      const body = await res.text();

      expect(body).toContain(`<link>${itemUrl}</link>`);
      expect(body).toContain(`<guid isPermaLink="true">${itemUrl}</guid>`);
    });
  });
});
