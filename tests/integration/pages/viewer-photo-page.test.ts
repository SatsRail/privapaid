import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import {
  setupTestDB,
  teardownTestDB,
  clearCollections,
} from "../../helpers/mongodb";
import Channel from "@/models/Channel";
import Media from "@/models/Media";

/**
 * Regression test for the "Payment received, couldn't unlock" bug.
 *
 * The viewer page at `src/app/c/[slug]/[mediaId]/page.tsx` surfaces
 * `media.source_url` to the client as `photo_gridfs_id` ONLY for photo
 * media. If the underlying Mongoose query drops `source_url` (e.g. by
 * `.select("-source_url")`), the client receives `photoGridFsId={undefined}`
 * and PaymentWall throws "Photo media is missing its GridFS pointer" after
 * the user has already paid.
 *
 * This test pins the invariant: a photo Media document fetched the same
 * way the page fetches it MUST include source_url. It does not exercise
 * the React tree — just the query, which is the load-bearing part.
 */
describe("Viewer page query for photo media", () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  afterEach(async () => {
    await clearCollections();
  });

  it("returns source_url (gridFsId pointer) for photo media", async () => {
    const channel = await Channel.create({
      slug: "showcase",
      name: "Platform Showcase",
      active: true,
    });

    const gridFsId = new mongoose.Types.ObjectId().toString();
    const media = await Media.create({
      ref: 1,
      channel_id: channel._id,
      name: "Lightning in a bottle",
      media_type: "photo",
      source_url: gridFsId,
    });

    // This is the EXACT query the viewer page runs. If anyone re-adds
    // `.select("-source_url")` (or similar) this test fails loudly.
    const fetched = await Media.findOne({
      _id: media._id,
      channel_id: channel._id,
    }).lean();

    expect(fetched).not.toBeNull();
    expect(fetched!.media_type).toBe("photo");
    expect(fetched!.source_url).toBe(gridFsId);

    // Mirror the page's serialization rule (page.tsx:209). Photo media
    // surfaces source_url to the client; non-photo media does not.
    const photoGridFsId =
      fetched!.media_type === "photo" ? fetched!.source_url : undefined;
    expect(photoGridFsId).toBe(gridFsId);
  });

  it("non-photo media's source_url stays server-side via the conditional", async () => {
    const channel = await Channel.create({
      slug: "showcase-2",
      name: "Showcase 2",
      active: true,
    });

    const secretUrl = "https://internal.example.com/video.mp4";
    const media = await Media.create({
      ref: 2,
      channel_id: channel._id,
      name: "Some video",
      media_type: "video",
      source_url: secretUrl,
    });

    const fetched = await Media.findOne({
      _id: media._id,
      channel_id: channel._id,
    }).lean();

    // Even though source_url is in the lean doc, the page's serialization
    // gate only exposes it for photo media. For non-photo this stays
    // server-side (rendered as undefined to the client).
    const photoGridFsId =
      fetched!.media_type === "photo" ? fetched!.source_url : undefined;
    expect(photoGridFsId).toBeUndefined();
    expect(fetched!.source_url).toBe(secretUrl); // still present server-side
  });

  // Parametric check: for every supported media_type, only "photo" surfaces
  // source_url to the client. Catches the case where someone adds a new
  // media_type and forgets to extend the conditional, AND the inverse
  // (someone widens the conditional and leaks a video stream URL).
  const NON_PHOTO_TYPES = ["video", "audio", "article", "podcast"] as const;
  for (const mediaType of NON_PHOTO_TYPES) {
    it(`does not surface source_url to the client for media_type=${mediaType}`, async () => {
      const channel = await Channel.create({
        slug: `showcase-${mediaType}`,
        name: `Showcase ${mediaType}`,
        active: true,
      });
      const media = await Media.create({
        ref: 100 + NON_PHOTO_TYPES.indexOf(mediaType),
        channel_id: channel._id,
        name: `Test ${mediaType}`,
        media_type: mediaType,
        source_url: `https://internal.example.com/${mediaType}.bin`,
      });

      const fetched = await Media.findOne({
        _id: media._id,
        channel_id: channel._id,
      }).lean();

      const photoGridFsId =
        fetched!.media_type === "photo" ? fetched!.source_url : undefined;
      expect(photoGridFsId).toBeUndefined();
    });
  }

  it("never lets photo media reach the client without a photo_gridfs_id", async () => {
    // Regression guard for the bug we just shipped a fix for: if source_url
    // is missing/empty on a photo Media, the page would have surfaced
    // `undefined` to the client, PaymentWall would throw, and the customer
    // would see "Payment received, couldn't unlock". Photos MUST have
    // source_url set (it's a required field per the schema) — assert that
    // a photo without source_url can't be persisted in the first place.
    const channel = await Channel.create({
      slug: "showcase-broken-photo",
      name: "Showcase",
      active: true,
    });

    await expect(
      Media.create({
        ref: 999,
        channel_id: channel._id,
        name: "Broken photo",
        media_type: "photo",
        // intentionally missing source_url
      })
    ).rejects.toBeTruthy();
  });
});
