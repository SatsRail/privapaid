/**
 * Resolve an image URL from either a GridFS image ID or a direct URL.
 * Priority: image_id → /api/images/{id}, then image_url, then empty string.
 */
export function resolveImageUrl(imageId?: string, imageUrl?: string): string {
  if (imageId) return `/api/images/${imageId}`;
  return imageUrl || "";
}

/**
 * A MediaImage row projected to the scalar fields needed to build a URL.
 * Deliberately excludes `bytes`: list/detail queries select only these columns
 * so Postgres never ships thumbnail blobs it would immediately discard.
 */
export interface MediaImageRef {
  id: string;
  kind: "thumbnail" | "preview";
  externalUrl: string | null;
  position: number;
}

/**
 * URL for a single MediaImage: the external URL when set (imported direct
 * links), otherwise the byte-serving route keyed by id.
 */
export function mediaImageUrl(image: Pick<MediaImageRef, "id" | "externalUrl">): string {
  return image.externalUrl ?? `/api/images/${image.id}`;
}

/**
 * Collapse a Media's `images` relation into the client-facing shape:
 *   thumbnailUrl — the `thumbnail` row's URL, or "" when there is none
 *   previewUrls  — every `preview` row's URL, ordered by `position`
 * This keeps the serialized payload identical to the old
 * thumbnailUrl / previewImageUrls fields so UI components need no changes.
 */
export function resolveMediaImages(images: MediaImageRef[]): {
  thumbnailUrl: string;
  previewUrls: string[];
} {
  const thumbnail = images
    .filter((img) => img.kind === "thumbnail")
    .sort((a, b) => a.position - b.position)[0];
  const previewUrls = images
    .filter((img) => img.kind === "preview")
    .sort((a, b) => a.position - b.position)
    .map(mediaImageUrl);
  return {
    thumbnailUrl: thumbnail ? mediaImageUrl(thumbnail) : "",
    previewUrls,
  };
}
