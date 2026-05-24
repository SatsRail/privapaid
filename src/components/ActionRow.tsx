"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/useLocale";

interface ActionRowProps {
  mediaId: string;
  mediaName: string;
}

/**
 * YouTube-style action row: a segmented Like/Dislike pill + Share pill +
 * Save pill, sized to match YouTube exactly (~36px tall, 20px icons,
 * tight horizontal padding).
 *
 * Local-only behaviour for now — Like/Dislike/Save persist via localStorage
 * so the same browser remembers the user's gesture across visits. Real
 * server-side likes / save-to-watch-later can wire later; the visual
 * surface is what makes the page feel YouTube-shaped.
 */
export default function ActionRow({ mediaId, mediaName }: ActionRowProps) {
  const { t } = useLocale();
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      setLiked(localStorage.getItem(`privapaid:liked:${mediaId}`) === "true");
      setDisliked(localStorage.getItem(`privapaid:disliked:${mediaId}`) === "true");
      setSaved(localStorage.getItem(`privapaid:saved:${mediaId}`) === "true");
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

  // Like and Dislike are mutually exclusive — clicking one clears the
  // other. Matches YouTube's behavior.
  function handleLike() {
    setLiked((prev) => {
      const next = !prev;
      writeFlag(`privapaid:liked:${mediaId}`, next);
      if (next && disliked) {
        setDisliked(false);
        writeFlag(`privapaid:disliked:${mediaId}`, false);
      }
      return next;
    });
  }

  function handleDislike() {
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

  function handleSave() {
    setSaved((prev) => {
      const next = !prev;
      writeFlag(`privapaid:saved:${mediaId}`, next);
      return next;
    });
  }

  async function handleShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: mediaName, url });
        return;
      } catch {
        // User cancelled or share unsupported — fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareToast(t("viewer.actions.copied"));
      setTimeout(() => setShareToast(null), 2000);
    } catch {
      setShareToast(t("viewer.actions.copy_failed"));
      setTimeout(() => setShareToast(null), 2000);
    }
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
          className="inline-flex h-full items-center gap-1.5 px-3 text-sm font-medium hover:opacity-80"
          style={{ color: "var(--theme-text)" }}
          aria-pressed={liked}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4.34-7.34A1 1 0 0 1 13 4l2 1.88z" />
          </svg>
          <span>{t("viewer.actions.like")}</span>
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
          className="inline-flex h-full items-center px-3 hover:opacity-80"
          style={{ color: "var(--theme-text)" }}
          aria-pressed={disliked}
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
        <span>{t("viewer.actions.share")}</span>
      </button>

      <button
        onClick={handleSave}
        data-testid="save-button"
        className={`${pillBase} rounded-full hover:opacity-80`}
        style={{ ...pillBg, color: "var(--theme-text)" }}
        aria-pressed={saved}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        <span>{t("viewer.actions.save")}</span>
      </button>

      {shareToast && (
        <span
          role="status"
          className="text-xs"
          style={{ color: "var(--theme-text-secondary)" }}
        >
          {shareToast}
        </span>
      )}
    </div>
  );
}
