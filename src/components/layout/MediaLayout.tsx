"use client";

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
import { useMediaAccess } from "@/lib/use-media-access";

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

  // Single source of truth for "does the viewer have paid access?" All
  // sibling components (MediaHeader pill, PaymentWall paywall/content,
  // CommentSection comment form) read from this one hook. No periodic
  // re-verification — the macaroon's own TTL is the source of truth for
  // how long access lasts; we don't second-guess it.
  const productIds = products.map((p) => p.productId);
  const { access, claim, refresh } = useMediaAccess({
    mediaId: media._id,
    products: products.map((p) => ({
      productId: p.productId,
      encryptedBlob: p.encryptedBlob,
      keyFingerprint: p.keyFingerprint,
    })),
    storedProductIds,
  });

  const hasActiveAccess = access.status === "active";
  const remainingSeconds = access.status === "active" ? access.remainingSeconds : null;

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
        access={access}
        onAccessClaim={claim}
        thumbnailUrl={thumbSrc}
        mediaType={media.media_type}
        photoGridFsId={media.photo_gridfs_id}
        merchantLogo={instanceConfig.theme.logo}
        merchantName={instanceConfig.name}
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
        Two-column layout from md+ (768px). Sidebar grows from 300px on md
        to 360px on lg so the content column stays usable on tablet-class
        widths. On mobile (<md) the grid collapses to a single column with
        comments at the bottom — natural source order makes this free.
      */}
      <div className="md:grid md:grid-cols-[1fr_300px] md:gap-6 lg:grid-cols-[1fr_360px] lg:gap-8">
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

          {/* Comments — mobile only. On md+ they live in the sidebar. */}
          <div className="md:hidden">
            <ErrorBoundary>
              <CommentSection
                mediaId={media._id}
                productIds={productIds}
                hasAccess={hasActiveAccess}
                onUnauthorized={refresh}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Right column — desktop/tablet comments sidebar (md+). */}
        <aside className="hidden md:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <ErrorBoundary>
              <CommentSection
                mediaId={media._id}
                productIds={productIds}
                hasAccess={hasActiveAccess}
                onUnauthorized={refresh}
              />
            </ErrorBoundary>
          </div>
        </aside>
      </div>
    </div>
  );
}
