"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/useLocale";

interface ActionRowProps {
  mediaId: string;
  mediaName: string;
  initialLikesCount: number;
  initialSharesCount: number;
  /**
   * Whether the viewer has active paid access for this media. Like and
   * Dislike are gated behind payment (same rule as Comments) — when
   * `false` the buttons render disabled and clicks are no-ops. Share
   * remains available regardless. MediaLayout owns the source of truth
   * via `useMediaAccess` and passes it down.
   */
  hasAccess: boolean;
  /**
   * Channel slug — when provided, an RSS Subscribe link is rendered at
   * the right edge of the action row, linking to /c/{slug}/feed.xml in
   * a new tab. Omit to hide the Subscribe affordance (e.g. on contexts
   * where the channel is implicit or the user is already on it).
   */
  channelSlug?: string;
}

/**
 * YouTube-style action row: a segmented Like/Dislike pill + Share pill,
 * sized to match YouTube exactly (~36px tall, 20px icons, tight
 * horizontal padding). When `channelSlug` is provided, an RSS Subscribe
 * pill is added at the right edge (pushed via `ml-auto`).
 *
 * Like and Share counts persist server-side via POST /api/media/[id]/like
 * and /share. Per-user toggle state for Like/Dislike stays in
 * localStorage — there is no server-side per-user uniqueness, so the
 * same browser remembers the user's gesture and the server only applies
 * the +1 / -1 delta. Dislike does not hit the server.
 *
 * Payment gating: Like and Dislike require active paid access (matches
 * the Comments pattern). Share and Subscribe are free. When `hasAccess`
 * is false the like/dislike buttons render with `disabled` + a "Pay to
 * react" title, and click handlers no-op without hitting the API.
 */
export default function ActionRow({
  mediaId,
  mediaName,
  initialLikesCount,
  initialSharesCount,
  hasAccess,
  channelSlug,
}: ActionRowProps) {
  const { t } = useLocale();
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [likesCount, setLikesCount] = useState(initialLikesCount);
  const [sharesCount, setSharesCount] = useState(initialSharesCount);
  const [actionToast, setActionToast] = useState<string | null>(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      setLiked(localStorage.getItem(`privapaid:liked:${mediaId}`) === "true");
      setDisliked(localStorage.getItem(`privapaid:disliked:${mediaId}`) === "true");
    } catch {
      // Storage disabled — session-only state.
    }
  }, [mediaId]);

  function writeFlag(key: string, value: boolean) {
    try {
      if (value) localStorage.setItem(key, "true");
      else localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  function showToast(message: string) {
    setActionToast(message);
    setTimeout(() => setActionToast(null), 2000);
  }

  // Like and Dislike are mutually exclusive — clicking one clears the
  // other. Matches YouTube's behavior. Both require paid access (same as
  // Comments); the buttons are also disabled at the DOM level when
  // `hasAccess` is false, this guard is defense-in-depth.
  async function handleLike() {
    if (!hasAccess) return;
    const next = !liked;
    const action = next ? "like" : "unlike";

    // Optimistic UI: flip state, adjust count (clamp at 0), clear dislike
    // if needed, write localStorage. Roll back if the server rejects.
    const previousLiked = liked;
    const previousDisliked = disliked;
    const previousLikes = likesCount;

    setLiked(next);
    setLikesCount((c) => (next ? c + 1 : Math.max(0, c - 1)));
    writeFlag(`privapaid:liked:${mediaId}`, next);
    if (next && disliked) {
      setDisliked(false);
      writeFlag(`privapaid:disliked:${mediaId}`, false);
    }

    try {
      const res = await fetch(`/api/media/${mediaId}/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { likes_count?: number };
      if (typeof data.likes_count === "number") {
        // Reconcile with the server in case of drift (rate-limit retries,
        // concurrent edits from other users).
        setLikesCount(data.likes_count);
      }
    } catch {
      setLiked(previousLiked);
      setLikesCount(previousLikes);
      writeFlag(`privapaid:liked:${mediaId}`, previousLiked);
      if (next && previousDisliked) {
        setDisliked(previousDisliked);
        writeFlag(`privapaid:disliked:${mediaId}`, previousDisliked);
      }
      showToast(t("viewer.actions.copy_failed"));
    }
  }

  function handleDislike() {
    if (!hasAccess) return;
    setDisliked((prev) => {
      const next = !prev;
      writeFlag(`privapaid:disliked:${mediaId}`, next);
      if (next && liked) {
        setLiked(false);
        writeFlag(`privapaid:liked:${mediaId}`, false);
      }
      return next;
    });
  }

  async function handleShare() {
    const url = window.location.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: mediaName, url });
      } catch {
        // User cancelled or share unsupported — fall through to clipboard.
        await copyToClipboard(url);
      }
    } else {
      await copyToClipboard(url);
    }
    incrementShareCount();
  }

  async function copyToClipboard(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t("viewer.actions.copied"));
    } catch {
      showToast(t("viewer.actions.copy_failed"));
    }
  }

  function incrementShareCount() {
    // Optimistic bump — the share already happened client-side, the POST
    // is best-effort telemetry. We don't roll back on failure.
    setSharesCount((c) => c + 1);
    fetch(`/api/media/${mediaId}/share`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { shares_count?: number };
        if (typeof data.shares_count === "number") {
          setSharesCount(data.shares_count);
        }
      })
      .catch(() => {
        // swallow — counts will reconcile on next page load.
      });
  }

  // Pill styling — h-9 (~36px) is YouTube's exact button height; px-3 +
  // gap-1.5 keeps the content tight without being cramped.
  const pillBase =
    "inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium transition-colors";
  const pillBg = { backgroundColor: "var(--theme-bg-secondary)" };

  return (
    <div
      data-testid="action-row"
      className="mt-3 flex flex-wrap items-center gap-2"
    >
      {/* Segmented Like / Dislike pill — single rounded container with a
          divider between the two halves. YouTube's exact pattern. */}
      <div
        className="inline-flex h-9 items-center overflow-hidden rounded-full"
        style={pillBg}
      >
        <button
          onClick={handleLike}
          data-testid="like-button"
          className="inline-flex h-full items-center gap-1.5 px-3 text-sm font-medium hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
          style={{ color: "var(--theme-text)" }}
          aria-pressed={liked}
          disabled={!hasAccess}
          title={!hasAccess ? t("viewer.actions.locked_hint") : undefined}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4.34-7.34A1 1 0 0 1 13 4l2 1.88z" />
          </svg>
          <span>
            {t("viewer.actions.like")}
            {likesCount > 0 && (
              <span data-testid="likes-count" className="ml-1">
                {likesCount}
              </span>
            )}
          </span>
        </button>
        <span
          aria-hidden="true"
          className="h-5 w-px"
          style={{ backgroundColor: "var(--theme-border)" }}
        />
        <button
          onClick={handleDislike}
          data-testid="dislike-button"
          aria-label={t("viewer.actions.dislike")}
          className="inline-flex h-full items-center px-3 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
          style={{ color: "var(--theme-text)" }}
          aria-pressed={disliked}
          disabled={!hasAccess}
          title={!hasAccess ? t("viewer.actions.locked_hint") : undefined}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={disliked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 14V2M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-4.34 7.34A1 1 0 0 1 11 20l-2-1.88z" />
          </svg>
        </button>
      </div>

      <button
        onClick={handleShare}
        data-testid="share-button"
        className={`${pillBase} rounded-full hover:opacity-80`}
        style={{ ...pillBg, color: "var(--theme-text)" }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span>
          {t("viewer.actions.share")}
          {sharesCount > 0 && (
            <span data-testid="shares-count" className="ml-1">
              {sharesCount}
            </span>
          )}
        </span>
      </button>

      {actionToast && (
        <span
          role="status"
          className="text-xs"
          style={{ color: "var(--theme-text-secondary)" }}
        >
          {actionToast}
        </span>
      )}

      {/* RSS Subscribe — pushed to the right edge of the action row via
          ml-auto. Click opens /c/{slug}/feed.xml in a new tab so the
          viewer's RSS reader (Feedly, NetNewsWire, Inoreader, etc.) can
          subscribe. The channel page also exposes the feed via a
          <link rel="alternate"> auto-discovery tag. */}
      {channelSlug && (
        <a
          href={`/c/${channelSlug}/feed.xml`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="subscribe-button"
          title={t("viewer.channel.subscribe_hint")}
          className={`${pillBase} ml-auto rounded-full hover:opacity-90`}
          style={{
            backgroundColor: "var(--theme-text)",
            color: "var(--theme-bg)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6.18 15.64a2.18 2.18 0 1 1 0 4.36 2.18 2.18 0 0 1 0-4.36zM4 4.44A15.56 15.56 0 0 1 19.56 20H16.5A12.5 12.5 0 0 0 4 7.5V4.44zm0 5.66A9.9 9.9 0 0 1 13.9 20H10.83A6.83 6.83 0 0 0 4 13.17V10.1z" />
          </svg>
          <span>{t("viewer.channel.subscribe")}</span>
        </a>
      )}
    </div>
  );
}
