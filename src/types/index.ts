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
  categoryId?: string;
  nsfw?: boolean;
  profileImageUrl?: string;
  socialLinks?: {
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
  channelId: string;
  name: string;
  description?: string;
  sourceUrl: string;
  mediaType: "video" | "audio" | "article" | "photo" | "podcast";
  thumbnailUrl?: string;
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
  id: string;
  name: string;
  slug: string;
  position: number;
  active: boolean;
  createdAt: string;
}

export interface SerializedAdmin {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedChannel {
  id: string;
  name: string;
  slug: string;
  bio: string;
  categoryId: string | null;
  categoryName?: string;
  nsfw: boolean;
  ref: number;
  profileImageUrl: string;
  socialLinks: Record<string, string>;
  isLive: boolean;
  active: boolean;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedMedia {
  id: string;
  channelId: string;
  name: string;
  description: string;
  mediaType: string;
  thumbnailUrl: string;
  position: number;
  commentsCount: number;
  flagsCount: number;
  productIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SerializedCustomer {
  id: string;
  nickname: string;
  favoriteChannelIds: string[];
  purchases: Array<{
    satsrailOrderId: string;
    satsrailProductId: string;
    purchasedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedComment {
  id: string;
  mediaId: string;
  customerId: string | null;
  customerNickname?: string;
  body: string;
  createdAt: string;
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
