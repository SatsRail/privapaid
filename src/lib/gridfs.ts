/**
 * @deprecated GridFS is gone — images and encrypted photo blobs now live in
 * Postgres `bytea` columns / dedicated tables (`Channel.profileImageBytes`,
 * `Media.thumbnailBytes`, `Settings.logoBytes`, `PreviewImage`, and
 * `EncryptedPhotoBlob`). This file is kept only so old imports don't fail
 * during the in-flight migration; remove every import and this file goes
 * away in the final sweep.
 */

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
