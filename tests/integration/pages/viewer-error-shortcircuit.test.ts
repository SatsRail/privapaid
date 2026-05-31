import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { setupTestDB, teardownTestDB, clearCollections } from "../../helpers/postgres";

/**
 * Part B short-circuit: a media flagged `status: "error"` has server-confirmed
 * undecryptable content. The viewer page must render the "temporarily
 * unavailable" wall and return BEFORE the product query, the macaroon-cookie
 * read, and the access hook ever mount — so a broken asset stops hitting the
 * SatsRail portal on every load. Admin preview (?preview=admin) is exempt so an
 * owner can still diagnose the failure.
 *
 * We invoke the server component directly and inspect the React element tree it
 * returns (never rendering it), so the heavy client subtree stays inert. The
 * `mediaProduct.findMany` spy and the `cookies()` spy are the behavioral
 * proof that the short-circuit ran before any portal-bound work.
 */

const { mockCookies } = vi.hoisted(() => ({ mockCookies: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({ cookies: mockCookies }));

vi.mock("@/config/instance", () => ({
  default: { nsfw: false },
  getInstanceConfig: vi.fn().mockResolvedValue({
    locale: "en",
    theme: { logo: "" },
    name: "Test Instance",
    currency: "USD",
    satsrail: { apiUrl: "https://satsrail.test/api/v1" },
  }),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

vi.mock("@/lib/jsonld", () => ({
  buildMediaSchema: vi.fn().mockReturnValue({}),
  buildBreadcrumbSchema: vi.fn().mockReturnValue({}),
}));

// Component mocks keep the page's import graph cheap and inert — we never
// render, so the bodies never run; the references are only used for tree
// identity assertions below.
vi.mock("@/components/ViewerShell", () => ({ default: () => null }));
vi.mock("@/components/MediaBreadcrumb", () => ({ default: () => null }));
vi.mock("@/components/UnavailableWall", () => ({ default: () => null }));
vi.mock("@/components/layout/MediaLayout", () => ({ default: () => null }));

import MediaPlayerPage from "@/app/c/[slug]/[mediaId]/page";
import UnavailableWall from "@/components/UnavailableWall";
import MediaLayout from "@/components/layout/MediaLayout";
import { prisma } from "@/lib/prisma";
import { envelopeCreateForUrl } from "../../helpers/crypto";

/**
 * Recursively search a returned React element tree for the first element whose
 * `type` matches `target`. We inspect the tree the server component returns
 * rather than rendering it, so client components stay inert.
 */
function findByType(
  node: unknown,
  target: unknown
): { type: unknown; props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === target) return el as { type: unknown; props: Record<string, unknown> };
  const children = el.props?.children;
  if (Array.isArray(children)) {
    for (const c of children) {
      const found = findByType(c, target);
      if (found) return found;
    }
  } else if (children) {
    return findByType(children, target);
  }
  return null;
}

let refSeed = 8000;
function nextRef(): number {
  refSeed += 1;
  return refSeed;
}

describe("Viewer page Part B short-circuit (Media.status = error)", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(() => {
    mockCookies.mockResolvedValue({ get: () => undefined });
  });

  afterEach(async () => {
    await clearCollections();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function seed(status: "ok" | "error") {
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `sc-${nextRef()}`, name: "SC Channel", active: true },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "SC Media",
        envelope: envelopeCreateForUrl("https://example.com/v.mp4"),
        mediaType: "video",
        status,
      },
    });
    return { slug: channel.slug, mediaId: media.id };
  }

  it("renders UnavailableWall and SKIPS the product query + macaroon-cookie read when status=error", async () => {
    const findManySpy = vi.spyOn(prisma.mediaProduct, "findMany");
    const { slug, mediaId } = await seed("error");

    const result = await MediaPlayerPage({
      params: Promise.resolve({ slug, mediaId }),
      searchParams: Promise.resolve({}),
    });

    const wall = findByType(result, UnavailableWall);
    expect(wall).not.toBeNull();
    expect(wall!.props.reason).toBe("error");
    // The normal layout (which mounts useMediaAccess → portal verify) is absent.
    expect(findByType(result, MediaLayout)).toBeNull();

    // Portal-protection win: no product lookup and no macaroon read happened.
    expect(findManySpy).not.toHaveBeenCalled();
    expect(mockCookies).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit for status=ok — the normal page (MediaLayout) renders and products are queried", async () => {
    const findManySpy = vi.spyOn(prisma.mediaProduct, "findMany");
    const { slug, mediaId } = await seed("ok");

    const result = await MediaPlayerPage({
      params: Promise.resolve({ slug, mediaId }),
      searchParams: Promise.resolve({}),
    });

    expect(findByType(result, MediaLayout)).not.toBeNull();
    expect(findByType(result, UnavailableWall)).toBeNull();
    expect(findManySpy).toHaveBeenCalled();
    expect(mockCookies).toHaveBeenCalled();
  });

  it("admin preview (?preview=admin) bypasses the short-circuit so an owner can still diagnose a flagged asset", async () => {
    const findManySpy = vi.spyOn(prisma.mediaProduct, "findMany");
    const { slug, mediaId } = await seed("error");

    const result = await MediaPlayerPage({
      params: Promise.resolve({ slug, mediaId }),
      searchParams: Promise.resolve({ preview: "admin" }),
    });

    // Falls through to the normal render path despite status=error.
    expect(findByType(result, UnavailableWall)).toBeNull();
    expect(findByType(result, MediaLayout)).not.toBeNull();
    expect(findManySpy).toHaveBeenCalled();
  });

  it("short-circuits to UnavailableWall when the media has no MediaEnvelope (incomplete content)", async () => {
    const findManySpy = vi.spyOn(prisma.mediaProduct, "findMany");
    // A media with NO envelope — e.g. an interrupted import/seed. Every media
    // must have exactly one MediaEnvelope holding its content; a missing one is
    // broken content with nothing to unlock, so it renders unavailable.
    const channel = await prisma.channel.create({
      data: { ref: nextRef(), slug: `sc-${nextRef()}`, name: "SC Channel", active: true },
    });
    const media = await prisma.media.create({
      data: {
        ref: nextRef(),
        channelId: channel.id,
        name: "No Envelope Media",
        mediaType: "video",
        status: "ok",
      },
    });

    const result = await MediaPlayerPage({
      params: Promise.resolve({ slug: channel.slug, mediaId: media.id }),
      searchParams: Promise.resolve({}),
    });

    expect(findByType(result, UnavailableWall)).not.toBeNull();
    expect(findByType(result, MediaLayout)).toBeNull();
    // Same portal-protection win: no product lookup, no macaroon read.
    expect(findManySpy).not.toHaveBeenCalled();
    expect(mockCookies).not.toHaveBeenCalled();
  });
});
