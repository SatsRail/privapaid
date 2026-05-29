"use client";

import { useState, useEffect, useCallback } from "react";

interface PreviewGalleryProps {
  images: string[]; // resolved URLs (GridFS or direct)
  locked?: boolean; // when true, disable lightbox (viewer hasn't paid)
  compact?: boolean; // smaller tiles, 5 per row (photo teasers)
}

export default function PreviewGallery({ images, locked, compact }: PreviewGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(compact ? null : null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  const goNext = useCallback(() => {
    if (compact) {
      setSelectedIndex((i) => (i !== null ? (i + 1) % images.length : 0));
    } else {
      setLightboxIndex((i) => (i !== null ? (i + 1) % images.length : null));
    }
  }, [images.length, compact]);

  const goPrev = useCallback(() => {
    if (compact) {
      setSelectedIndex((i) =>
        i !== null ? (i - 1 + images.length) % images.length : images.length - 1
      );
    } else {
      setLightboxIndex((i) =>
        i !== null ? (i - 1 + images.length) % images.length : null
      );
    }
  }, [images.length, compact]);

  useEffect(() => {
    const activeIndex = compact ? selectedIndex : lightboxIndex;
    if (activeIndex === null) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (compact) setSelectedIndex(null);
        else closeLightbox();
      } else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
    }

    document.addEventListener("keydown", handleKey);
    if (!compact) document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey);
      if (!compact) document.body.style.overflow = "";
    };
  }, [selectedIndex, lightboxIndex, closeLightbox, goNext, goPrev, compact]);

  if (!images.length) return null;

  const cols = compact
    ? "grid-cols-5"
    : images.length <= 2 ? "grid-cols-2" : "grid-cols-3";

  function handleTileClick(i: number) {
    if (locked && !compact) return;
    if (compact) {
      setSelectedIndex((prev) => (prev === i ? null : i));
    } else {
      setLightboxIndex(i);
    }
  }

  return (
    <>
      {/* Inline viewer for compact mode (photo) */}
      {compact && selectedIndex !== null && (
        <div className="relative mb-4 overflow-hidden rounded-lg border border-[var(--theme-border)] bg-black">
          {/* Navigation arrows */}
          {images.length > 1 && (
            <button
              onClick={goPrev}
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
              aria-label="Previous"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={images[selectedIndex]}
            alt={`Photo ${selectedIndex + 1}`}
            className="mx-auto max-h-[60vh] object-contain"
          />
          {images.length > 1 && (
            <button
              onClick={goNext}
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
              aria-label="Next"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
          {/* Counter */}
          <div className="absolute bottom-3 right-3 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
            {selectedIndex + 1} / {images.length}
          </div>
        </div>
      )}

      {/* Thumbnail grid */}
      <div className={`grid ${cols} gap-2`}>
        {images.map((url, i) => (
          <button
            key={i}
            onClick={() => handleTileClick(i)}
            className={`group relative overflow-hidden rounded-lg border bg-[var(--theme-bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary)] ${compact ? "aspect-[4/3]" : "aspect-square"} ${locked ? "cursor-default" : ""} ${compact && selectedIndex === i ? "border-[var(--theme-primary)] ring-2 ring-[var(--theme-primary)]" : "border-[var(--theme-border)]"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Preview ${i + 1}`}
              loading="lazy"
              className={`h-full w-full object-cover transition-all duration-200 ${locked ? "" : "group-hover:scale-105 group-hover:brightness-110"}`}
            />
            {locked && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/70">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Full-screen lightbox (non-compact mode only) */}
      {!compact && lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={closeLightbox}
        >
          <button
            onClick={closeLightbox}
            className="absolute right-4 top-4 z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            aria-label="Close"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          {images.length > 1 && (
            <div className="absolute left-4 top-4 z-10 rounded-full bg-black/50 px-3 py-1 text-sm text-white">
              {lightboxIndex + 1} / {images.length}
            </div>
          )}
          {images.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); goPrev(); }}
              className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white hover:bg-black/70"
              aria-label="Previous"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div
            className="flex max-h-[85vh] max-w-[90vw] items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[lightboxIndex]}
              alt={`Preview ${lightboxIndex + 1}`}
              className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
            />
          </div>
          {images.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); goNext(); }}
              className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white hover:bg-black/70"
              aria-label="Next"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>
      )}
    </>
  );
}
