import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

export interface IMedia extends Document {
  ref: number;
  channel_id: Types.ObjectId;
  name: string;
  description: string;
  source_url: string; // plain URL, never exposed to client
  media_type: MediaType;
  /**
   * For photo media only: the per-photo DEK wrapped under the operator's
   * PHOTO_KEK. Populated on photo creation so subsequent product creations
   * can recover the DEK without a SatsRail round-trip and without depending
   * on any other MediaProduct existing. See src/lib/photo-dek.ts.
   *
   * Undefined for non-photo media and for legacy photos that pre-date this
   * field (the backfill script populates them).
   */
  encrypted_dek?: string;
  thumbnail_url: string;
  thumbnail_id: string;
  preview_image_ids: string[]; // GridFS image IDs (admin uploads)
  preview_image_urls: string[]; // Direct URLs (from import)
  position: number;
  comments_count: number;
  views_count: number;
  flags_count: number;
  likes_count: number;
  shares_count: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const MediaSchema = new Schema<IMedia>(
  {
    ref: {
      type: Number,
      unique: true,
    },
    channel_id: {
      type: Schema.Types.ObjectId,
      ref: "Channel",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Holds the plaintext source: a URL for video/audio/podcast, the body
    // text for articles, or a GridFS pointer to ciphertext bytes for photos.
    // For photos, the bytes at the GridFS pointer are encrypted at rest.
    // For everything else, this is sensitive plaintext — public routes MUST
    // filter it out (see `src/app/c/[slug]/[mediaId]/page.tsx` for the
    // canonical photo-only conditional). The re-encryption flow reads this
    // field directly so rotation doesn't depend on SatsRail still returning
    // the old_key — that pipeline has proven unreliable.
    source_url: {
      type: String,
      required: true,
    },
    media_type: {
      type: String,
      required: true,
      enum: ["video", "audio", "article", "photo", "podcast"],
      default: "video",
    },
    encrypted_dek: {
      type: String,
      default: undefined,
    },
    thumbnail_url: {
      type: String,
      default: "",
    },
    thumbnail_id: {
      type: String,
      default: "",
    },
    preview_image_ids: {
      type: [String],
      default: [],
      validate: [(v: string[]) => v.length <= 6, "Maximum 6 preview images"],
    },
    preview_image_urls: {
      type: [String],
      default: [],
      validate: [(v: string[]) => v.length <= 6, "Maximum 6 preview image URLs"],
    },
    position: {
      type: Number,
      default: 0,
    },
    comments_count: {
      type: Number,
      default: 0,
    },
    views_count: {
      type: Number,
      default: 0,
    },
    flags_count: {
      type: Number,
      default: 0,
    },
    likes_count: {
      type: Number,
      default: 0,
    },
    shares_count: {
      type: Number,
      default: 0,
    },
    deleted_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

MediaSchema.index({ channel_id: 1, position: 1 });
MediaSchema.index({ channel_id: 1, views_count: -1 });
MediaSchema.index({ created_at: -1 });

const Media: Model<IMedia> =
  mongoose.models.Media || mongoose.model<IMedia>("Media", MediaSchema);

export default Media;
