"use client";

import type { MediaPageData } from "@/app/c/[slug]/[mediaId]/types";
import MediaBreadcrumb from "@/components/MediaBreadcrumb";
import MediaHeader from "@/components/MediaHeader";
import MediaMeta from "@/components/MediaMeta";
import UnavailableWall from "@/components/UnavailableWall";
import PaymentWall from "@/components/PaymentWall";
import PreviewGallery from "@/components/PreviewGallery";
import CommentSection from "@/components/CommentSection";
import ChannelSidebar from "@/components/ChannelSidebar";
import ChannelBlock from "@/components/ChannelBlock";
import ActionRow from "@/components/ActionRow";
import ExpandableDescription from "@/components/ExpandableDescription";
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
  siblingMedia,
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

  // Channel-of-one collapses to single column — empty rail is uglier than
  // no rail. siblingMedia is server-decided (page.tsx fetches all-but-current
  // media in the channel, capped at 20, sorted by views desc).
  const hasSidebar = siblingMedia.length > 0;

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
    <div className="mx-auto max-w-[1800px] px-6 py-8">
      <MediaBreadcrumb
        channelName={channel.name}
        channelSlug={channel.slug}
        mediaName={media.name}
        locale={locale}
      />

      {/*
        YouTube-style two-column layout. On md+ (≥768px) the right column
        holds the "more from this channel" sidebar. On mobile the grid
        collapses to a single column — sidebar is skipped entirely (founder
        decision; mobile users navigate via the channel page).
        Sidebar widths: 320px on md, 360px on lg — same proportions YouTube
        uses on the watch page at comparable breakpoints. Outer cap raised
        to 1800px so a 1280px video + 360px sidebar fits without crowding.
      */}
      <div
        className={
          hasSidebar
            ? "md:grid md:grid-cols-[1fr_320px] md:gap-6 lg:grid-cols-[1fr_360px] lg:gap-8"
            : ""
        }
      >
        {/* Left column — primary content + comments. Comments live HERE
            (not in the right column) so the right column can host the
            sibling-media rail. min-w-0 keeps long titles / wide videos from
            blowing out the grid track.

            Reading order: video → title → meta (views + price/clock) →
            description → preview gallery → comments. Video-first matches
            the YouTube watch page; user sees the content before any
            framing chrome. */}
        <div className="min-w-0">
          {mainContent}

          <MediaHeader
            name={media.name}
            products={products}
            locale={locale}
            remainingSeconds={remainingSeconds}
          />

          {/* YouTube-style meta row: views sit under the title, above the
              action row. Now that the title also sits under the video,
              the title + meta + action row + channel block form a coherent
              "info block" directly beneath the player. */}
          <MediaMeta viewsCount={media.views_count} locale={locale} />

          {/* YouTube-style action row — Like / Share / Save pills. The
              visual presence is the goal; backend wiring is local-storage
              only for now. Real "like feed" / "watch later" lift later. */}
          <ActionRow
            mediaId={media._id}
            mediaName={media.name}
            initialLikesCount={media.likes_count}
            initialSharesCount={media.shares_count}
            hasAccess={hasActiveAccess}
          />

          {/* Channel attribution + Subscribe pill. The Subscribe button is
              localStorage-only today; the visual surface is what makes the
              page feel YouTube-shaped, not a real subscriber count. */}
          <ChannelBlock
            name={channel.name}
            slug={channel.slug}
            profileImageUrl={channel.profileImageUrl}
          />

          {/* Description — auto-collapses to 2 lines with a "...more"
              toggle when the content overflows. Tight, scannable info
              block above the comments. */}
          {media.description && <ExpandableDescription text={media.description} />}

          {/* Preview images */}
          {hasPreview && (
            <div className="mt-6">
              <PreviewGallery images={previewImages} />
            </div>
          )}

          {/* Comments — single placement on every breakpoint. The duplicate
              md:hidden / hidden md:block pair we used to render is gone:
              now the right column hosts the channel sidebar, not comments. */}
          <ErrorBoundary>
            <CommentSection
              mediaId={media._id}
              productIds={productIds}
              hasAccess={hasActiveAccess}
              onUnauthorized={refresh}
            />
          </ErrorBoundary>
        </div>

        {/* Right column — md+ only. Sticky so the rail follows the viewer
            as they scroll through long descriptions / comment threads. */}
        {hasSidebar && (
          <aside className="hidden md:block">
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
              <ChannelSidebar items={siblingMedia} locale={locale} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
