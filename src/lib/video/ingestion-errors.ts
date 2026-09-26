export const ingestionMessages = {
  INVALID_UPLOAD: "Choose an H.264 MP4 with optional AAC audio, up to 10 GiB.",
  UPLOAD_NOT_FOUND: "This upload is unavailable for your account.",
  UPLOAD_CLOSED: "This upload has expired or closed. Start a new upload.",
  UPLOAD_CONFLICT: "The selected file or upload offset does not match. Resume with the original file.",
  UPLOAD_BUSY: "Another transfer is active. Retry shortly.",
  STORAGE_QUOTA: "This instance has reached its video storage reservation limit.",
  JOB_QUOTA: "Other videos are still uploading or processing. Retry when one finishes.",
  STORAGE_FULL: "Private storage is nearly full. Free space before continuing.",
  CHECKSUM_MISMATCH: "This part did not arrive intact. Retry the upload.",
  PRODUCT_REQUIRED: "Associate an active paid product and its key before uploading.",
  ROTATION_PENDING: "Finish product-key rotation, then resume this upload.",
  KEY_STATE_CHANGED: "The product association or key changed. Finish rotation and resume, or start a new upload.",
  KEY_SERVICE_UNAVAILABLE: "Key verification is temporarily unavailable. Retry without starting another upload.",
  INVALID_VIDEO: "Use an MP4 with one H.264 video track and optional AAC audio, up to 4K/60 fps and four hours.",
  OUTPUT_INVALID: "The processed video did not pass integrity and timeline checks. Retry processing.",
  PROCESSOR_UNAVAILABLE: "Video processing is unavailable. Check the worker and FFmpeg installation.",
  JOB_TIMEOUT: "Processing exceeded this instance's time limit. Check worker capacity before retrying.",
  WORKER_STOPPED: "Processing was interrupted. The worker will retry safely.",
  STORAGE_UNAVAILABLE: "Video storage is temporarily unavailable. Retry shortly.",
  SOURCE_EXPIRED: "The retained upload has been cleaned up. Upload the original file again.",
} as const;
export type IngestionCode = keyof typeof ingestionMessages;
export class IngestionError extends Error {
  constructor(readonly code: IngestionCode, readonly status = 409, readonly retryable = false) { super(code); }
}
