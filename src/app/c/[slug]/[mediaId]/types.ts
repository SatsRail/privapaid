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
    /** Resolved avatar URL — either /api/images/<gridfs_id> or a raw URL.
     *  Used by the YouTube-style ChannelBlock under the video. */
    profileImageUrl?: string;
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
  /**
   * Other media items in the same channel (excluding the current one),
   * served pre-serialized with everything the sidebar needs to render
   * without further server work. Sorted by views descending — the founder's
   * choice for what to surface as "up next" — and capped at 20 items.
   * Empty array on a single-media channel.
   */
  siblingMedia: SiblingMediaItem[];
}

export interface SiblingMediaItem {
  _id: string;
  name: string;
  /** Resolved thumbnail URL — handles thumbnail_id (GridFS) vs raw URL. */
  thumbnailSrc?: string;
  mediaType: string;
  viewsCount: number;
  /** Pre-built canonical href: /c/<slug>/<id>. Sidebar doesn't need to know the slug. */
  href: string;
  /** ISO-8601 created_at — drives the "3 days ago" sub-label, YouTube-style. */
  createdAt: string;
}
