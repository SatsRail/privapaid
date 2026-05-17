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
  const useSidebar = hasPreview;

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
    <div className={`mx-auto px-6 py-8 ${useSidebar ? "max-w-6xl" : "max-w-4xl"}`}>
      <MediaBreadcrumb
        channelName={channel.name}
        channelSlug={channel.slug}
        mediaName={media.name}
        locale={locale}
      />

      <div className={useSidebar ? "lg:grid lg:grid-cols-[1fr_280px] lg:gap-8" : ""}>
        {/* Left column */}
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

          {/* Preview images — mobile fallback */}
          {hasPreview && (
            <div className="mt-6 lg:hidden">
              <PreviewGallery images={previewImages} />
            </div>
          )}

          {/* Comments */}
          <ErrorBoundary>
            <CommentSection
              mediaId={media._id}
              productIds={products.map((p) => p.productId)}
              storedProductIds={storedProductIds}
            />
          </ErrorBoundary>
        </div>

        {/* Right column — preview sidebar */}
        {useSidebar && (
          <div className="hidden lg:block">
            <div className="sticky top-20">
              <PreviewGallery images={previewImages} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
