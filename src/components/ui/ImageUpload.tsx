"use client";

import { useState, useRef } from "react";

interface ImageUploadProps {
  context: string;
  currentImageId?: string;
  currentImageUrl?: string;
  onUpload: (imageId: string) => void;
  label?: string;
}

export default function ImageUpload({
  context,
  currentImageId,
  currentImageUrl,
  onUpload,
  label = "Image",
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentSrc = currentImageId
    ? `/api/images/${encodeURIComponent(currentImageId)}`
    : currentImageUrl && /^(https?:\/\/|\/)/.test(currentImageUrl)
      ? currentImageUrl
      : null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setPreview(URL.createObjectURL(file));
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("context", context);

      const res = await fetch("/api/images", {
        method: "POST",
        body: formData,
      });

      // The server may return a non-JSON body for unhandled exceptions
      // (Next's default 500 page is HTML). Parse defensively so we can still
      // surface the status code rather than swallowing the failure as
      // a generic "Upload failed".
      let data: { image_id?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        /* response wasn't JSON — `data` stays empty */
      }

      if (!res.ok) {
        const fallback = `Upload failed (${res.status}${
          res.statusText ? ` ${res.statusText}` : ""
        })`;
        setError(data.error || fallback);
        setPreview(null);
        return;
      }

      if (!data.image_id) {
        setError("Upload succeeded but server returned no image id");
        setPreview(null);
        return;
      }

      onUpload(data.image_id);
    } catch (err) {
      console.error("ImageUpload: request failed", err);
      const message = err instanceof Error ? err.message : "Network error";
      setError(`Upload failed: ${message}`);
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }

  const rawSrc = preview || currentSrc;
  // Explicitly validate the URL scheme so static analysis tools (CodeQL) can
  // confirm no javascript: or data: URIs reach the img src attribute.
  const displaySrc =
    rawSrc && /^(blob:|https?:\/\/|\/)/.test(rawSrc) ? rawSrc : null;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-[var(--theme-text)]">
        {label}
      </label>

      <div className="flex items-center gap-4">
        {displaySrc && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            /* displaySrc is URL-scheme-guarded above (blob:/http(s)/relative only). */
            /* codeql[js/xss-through-dom] */
            src={displaySrc}
            alt={label}
            className="h-20 w-20 rounded-md border border-[var(--theme-border)] object-cover"
          />
        )}

        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--theme-bg-secondary)] px-3 py-1.5 text-sm font-medium text-[var(--theme-text)] transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <>
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Uploading...
              </>
            ) : displaySrc ? (
              "Change Image"
            ) : (
              "Upload Image"
            )}
          </button>
          <span className="text-xs text-[var(--theme-text-secondary)]">
            JPEG, PNG, WebP, or GIF (max 5MB)
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
