"use client";

import { useState, useEffect } from "react";
import ContentRenderer from "@/components/ContentRenderer";

interface AdminPreviewContentProps {
  mediaId: string;
  mediaType: string;
}

export default function AdminPreviewContent({ mediaId, mediaType }: AdminPreviewContentProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchPreview() {
      try {
        const res = await fetch(`/api/admin/media/${mediaId}/preview`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;

        const encoded = new TextEncoder().encode(data.source_url);
        setBytes(encoded);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load preview");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPreview();
    return () => { cancelled = true; };
  }, [mediaId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg-secondary)] p-12">
        <div className="flex items-center gap-3 text-sm text-[var(--theme-text-secondary)]">
          <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading preview...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--theme-error)]/50 bg-[var(--theme-error)]/30 px-4 py-3">
        <p className="text-sm text-[var(--theme-error)]">Preview failed: {error}</p>
      </div>
    );
  }

  if (!bytes) return null;

  return <ContentRenderer decryptedBytes={bytes} mediaType={mediaType} mediaId={mediaId} ownerPreview />;
}
