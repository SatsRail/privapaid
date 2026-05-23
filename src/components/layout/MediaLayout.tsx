"use client";

import { useState, useCallback } from "react";
import type { MediaPageData } from "@/app/c/[slug]/[mediaId]/types";
import MediaBreadcrumb from "@/components/MediaBreadcrumb";
import MediaHeader from "@/components/MediaHeader";
import UnavailableWall from "@/components/UnavailableWall";
import PaymentWall from "@/components/PaymentWall";
import PreviewGallery from "@/components/PreviewGallery";
import CommentSection from "@/components/CommentSection";
import ErrorBoundary from "@/components/ErrorBoundary";
import AdminPreviewBanner from "@/components/AdminPreviewBanner";
import AdminPreviewContent from "@/components/AdminPreviewContent";

export default function MediaLayout({
  media,
  channel,
  products,
  storedProductIds,
  previewImages,
  thumbSrc,
  locale,
  instanceConfig,
  adminPreviewSourceUrl,
}: MediaPageData) {
  const hasPreview = previewImages.length > 0;
  // Always render the desktop sidebar — it holds the comments column.
  // Preview images, when present, share the right column above comments.
  const useSidebar = true;

  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const handleExpired = useCallback(() => setRemainingSeconds(null), []);

  const mainContent = adminPreviewSourceUrl ? (
    <>
      <AdminPreviewBanner mediaName={media.name} />
      <AdminPreviewContent mediaId={media._id} mediaType={media.media_type} />
    </>
  ) : products.length > 0 ? (
    <ErrorBoundary>
      <PaymentWall
        mediaId={media._id}
        products={products}
        storedProductIds={storedProductIds}
        thumbnailUrl={thumbSrc}
        mediaType={media.media_type}
        photoGridFsId={media.photo_gridfs_id}
        merchantLogo={instanceConfig.theme.logo}
        merchantName={instanceConfig.name}
        onRemainingSeconds={setRemainingSeconds}
        onExpired={handleExpired}
      />
    </ErrorBoundary>
  ) : (
    <UnavailableWall
      variant="overlay"
      thumbnailUrl={thumbSrc}
      mediaName={media.name}
      locale={locale}
    />
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <MediaBreadcrumb
        channelName={channel.name}
        channelSlug={channel.slug}
        mediaName={media.name}
        locale={locale}
      />

      {/*
        Two-column layout on desktop (lg+):
          left  = content (header, paywall/player, description, preview images)
          right = sticky comments column (Twitch/YouTube-style sidebar)
        On mobile the grid collapses to a single column with comments at
        the bottom — the natural source order makes this free.
      */}
      <div className="lg:grid lg:grid-cols-[1fr_360px] lg:gap-8">
        {/* Left column — primary content */}
        <div className="min-w-0">
          <MediaHeader
            name={media.name}
            products={products}
            viewsCount={media.views_count}
            commentsCount={media.comments_count}
            locale={locale}
            remainingSeconds={remainingSeconds}
          />

          {mainContent}

          {/* Description */}
          {media.description && (
            <p className="mt-4" style={{ color: "var(--theme-text)" }}>{media.description}</p>
          )}

          {/* Preview images — under content on every breakpoint now that
              the sidebar is reserved for comments. */}
          {hasPreview && (
            <div className="mt-6">
              <PreviewGallery images={previewImages} />
            </div>
          )}

          {/* Comments — mobile only. On desktop they live in the sidebar. */}
          <div className="lg:hidden">
            <ErrorBoundary>
              <CommentSection
                mediaId={media._id}
                productIds={products.map((p) => p.productId)}
                storedProductIds={storedProductIds}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Right column — desktop comments sidebar */}
        <aside className="hidden lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <ErrorBoundary>
              <CommentSection
                mediaId={media._id}
                productIds={products.map((p) => p.productId)}
                storedProductIds={storedProductIds}
              />
            </ErrorBoundary>
          </div>
        </aside>
      </div>
    </div>
  );
}
