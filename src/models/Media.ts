import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type MediaType = "video" | "audio" | "article" | "photo" | "podcast";

export interface IMedia extends Document {
  ref: number;
  channel_id: Types.ObjectId;
  name: string;
  description: string;
  source_url: string; // plain URL, never exposed to client
  media_type: MediaType;
  thumbnail_url: string;
  thumbnail_id: string;
  preview_image_ids: string[]; // GridFS image IDs (admin uploads)
  preview_image_urls: string[]; // Direct URLs (from import)
  position: number;
  comments_count: number;
  views_count: number;
  flags_count: number;
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
