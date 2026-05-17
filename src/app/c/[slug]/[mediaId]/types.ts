export interface SerializedProduct {
  productId: string;
  encryptedBlob: string;
  keyFingerprint?: string;
  name?: string;
  priceCents?: number;
  currency?: string;
  accessDurationSeconds?: number;
  status?: string;
}

export interface MediaPageData {
  media: {
    _id: string;
    name: string;
    description?: string;
    media_type: string;
    thumbnail_url?: string;
    thumbnail_id?: string;
    views_count: number;
    comments_count: number;
    // For media_type === "photo" only: the GridFS ID of the encrypted bytes.
    // Not sensitive on its own (bytes are ciphertext without the DEK).
    photo_gridfs_id?: string;
  };
  channel: {
    name: string;
    slug: string;
  };
  products: SerializedProduct[];
  storedProductIds: string[];
  previewImages: string[];
  thumbSrc: string | undefined;
  locale: string;
  instanceConfig: {
    theme: { logo?: string };
    name: string;
  };
  adminPreviewSourceUrl?: string | null;
}
