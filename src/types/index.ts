import type { Types } from "mongoose";

// --- API Response wrapper ---

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  errors?: Record<string, string>;
}

// --- Form data types ---

export interface CategoryFormData {
  name: string;
  slug?: string;
  position?: number;
  active?: boolean;
}

export interface AdminFormData {
  email: string;
  name: string;
  password?: string;
  role: "owner" | "admin" | "moderator";
  active?: boolean;
}

export interface ChannelFormData {
  name: string;
  slug?: string;
  bio?: string;
  category_id?: string;
  nsfw?: boolean;
  profile_image_url?: string;
  social_links?: {
    youtube?: string;
    twitter?: string;
    discord?: string;
    instagram?: string;
    tiktok?: string;
    website?: string;
  };
  active?: boolean;
}

export interface MediaFormData {
  channel_id: string;
  name: string;
  description?: string;
  source_url: string;
  media_type: "video" | "audio" | "article" | "photo" | "podcast";
  thumbnail_url?: string;
  position?: number;
}

export interface CreateProductFormData {
  name: string;
  price_cents: number;
  currency?: string;
  access_duration_seconds?: number;
  image_url?: string;
}

// --- Serialized document types (for API responses) ---

export interface SerializedCategory {
  _id: string;
  name: string;
  slug: string;
  position: number;
  active: boolean;
  created_at: string;
}

export interface SerializedAdmin {
  _id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SerializedChannel {
  _id: string;
  name: string;
  slug: string;
  bio: string;
  category_id: string | null;
  category_name?: string;
  nsfw: boolean;
  ref: number;
  profile_image_url: string;
  social_links: Record<string, string>;
  is_live: boolean;
  active: boolean;
  media_count: number;
  created_at: string;
  updated_at: string;
}

export interface SerializedMedia {
  _id: string;
  channel_id: string;
  name: string;
  description: string;
  media_type: string;
  thumbnail_url: string;
  position: number;
  comments_count: number;
  flags_count: number;
  product_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface SerializedCustomer {
  _id: string;
  nickname: string;
  favorite_channel_ids: string[];
  purchases: Array<{
    satsrail_order_id: string;
    satsrail_product_id: string;
    purchased_at: string;
  }>;
  created_at: string;
  updated_at: string;
}

export interface SerializedComment {
  _id: string;
  media_id: string;
  customer_id: string;
  customer_nickname?: string;
  body: string;
  created_at: string;
}

// --- Pagination ---

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}
