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
import { useLocale } from "@/i18n/useLocale";

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
  const { t } = useLocale();
  const hasPreview = previewImages.length > 0;

  // Single source of truth for "does the viewer have paid access?" All
  // sibling components (MediaHeader pill, PaymentWall paywall/content)
  // read from this one hook. No periodic re-verification — the
  // macaroon's own TTL is the source of truth for how long access
  // lasts; we don't second-guess it.
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

  // Access-first: while the hook is still verifying (only possible when the
  // server-render found a stored macaroon for this media), hide the price
  // pills. First-time viewers seed synchronously to "inactive" and never
  // enter this state, so the paywall still shows immediately for them.
  const checkingAccess = access.status === "loading";

  // Channel-of-one collapses to single column — empty rail is uglier than
  // no rail. siblingMedia is server-decided (page.tsx fetches all-but-current
  // media in the channel, capped at 20, sorted by views desc).
  const hasSidebar = siblingMedia.length > 0;

  // The right rail hosts preview images (top) and the sibling-media list.
  // Either one is enough to warrant the two-column grid — previews alone
  // should pull the layout into two columns rather than stack full-width.
  const hasRail = hasPreview || hasSidebar;

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
        envelopeId={media.envelope_id}
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
          hasRail
            ? "md:grid md:grid-cols-[1fr_320px] md:gap-6 lg:grid-cols-[1fr_360px] lg:gap-8"
            : ""
        }
      >
        {/* Left column — primary content + comments. Comments live HERE
            (not in the right column) so the right column can host the
            sibling-media rail. min-w-0 keeps long titles / wide videos from
            blowing out the grid track.

            Reading order: video → title → meta (views) → actions → channel →
            description → (mobile previews) → comments. Video-first matches
            the YouTube watch page; user sees the content before any framing
            chrome.

            Vertical rhythm (each gap lives on the child's own root margin):
            the identity cluster (title + price pills + views) is bound tight
            at mt-2 so it reads as one unit; the engagement/attribution/detail
            sections (actions, channel, description) each break at mt-4; the
            comments zone is set apart by a hairline divider with mt-6/pt-6.
            Two gap sizes (8px within, 16px between) create the grouping. */}
        <div className="min-w-0">
          {mainContent}

          <MediaHeader
            name={media.name}
            products={products}
            locale={locale}
            remainingSeconds={remainingSeconds}
            checkingAccess={checkingAccess}
          />

          {/* YouTube-style meta row: views sit under the title, above the
              action row. Now that the title also sits under the video,
              the title + meta + action row + channel block form a coherent
              "info block" directly beneath the player. */}
          <MediaMeta viewsCount={media.views_count} locale={locale} />

          {/* YouTube-style action row — Like / Dislike / Share. No
              Subscribe button: channels expose an RSS feed at
              /c/{slug}/feed.xml and the channel page's <head> carries a
              <link rel="alternate" type="application/rss+xml"> for
              auto-discovery by RSS reader extensions and standalone
              readers. We keep the visible UI free of a "Subscribe to
              XML" button to avoid confusing casual viewers. */}
          <ActionRow
            mediaId={media._id}
            mediaName={media.name}
            initialLikesCount={media.likes_count}
            initialSharesCount={media.shares_count}
            hasAccess={hasActiveAccess}
          />

          {/* Channel attribution — avatar + name + media-count link to the
              channel page, which is also where viewers discover and re-engage
              with the channel's content. */}
          <ChannelBlock
            name={channel.name}
            slug={channel.slug}
            profileImageUrl={channel.profileImageUrl}
            mediaCount={channel.mediaCount}
          />

          {/* Description — auto-collapses to 2 lines with a "...more"
              toggle when the content overflows. Tight, scannable info
              block above the comments. */}
          {media.description && <ExpandableDescription text={media.description} />}

          {/* Preview images — mobile only. On md+ these live in the right
              rail (the aside is hidden below md), so this inline copy serves
              phone viewers who never see the rail. */}
          {hasPreview && (
            <div className="mt-6 md:hidden">
              <PreviewGallery images={previewImages} />
            </div>
          )}

          {/* Comments — anonymous, macaroon-gated form. A single hairline
              divider sets the discussion apart from the info block above it;
              the generous mt-6/pt-6 gives the seam room to breathe so the
              page reads as "content, then conversation" rather than one
              undifferentiated stack. */}
          <div className="mt-6 border-t border-[var(--theme-border)] pt-6">
            <ErrorBoundary>
              <CommentSection
                mediaId={media._id}
                hasAccess={hasActiveAccess}
                onUnauthorized={refresh}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Right rail — md+ only. Sticky so it follows the viewer as they
            scroll through long descriptions / comment threads. Preview images
            sit at the top, the sibling-media list below.

            Both rail sections share one flat treatment: a small section
            label, then content, separated by a hairline divider. No
            background card — that matches the page's "content sits inline,
            not in form-like boxes" rule (see ExpandableDescription) and keeps
            the previews and the sibling list reading as one organized panel
            rather than two mismatched widgets. */}
        {hasRail && (
          <aside className="hidden md:block">
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] divide-y divide-[var(--theme-border)] overflow-y-auto">
              {hasPreview && (
                <section className="pb-6">
                  <h2
                    className="mb-3 text-sm font-medium"
                    style={{ color: "var(--theme-text-secondary)" }}
                  >
                    {t("viewer.sidebar.previews")}
                  </h2>
                  <PreviewGallery images={previewImages} />
                </section>
              )}
              {hasSidebar && (
                <section className={hasPreview ? "pt-6" : undefined}>
                  <ChannelSidebar items={siblingMedia} locale={locale} />
                </section>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
