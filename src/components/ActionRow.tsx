"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/useLocale";

interface ActionRowProps {
  mediaId: string;
  mediaName: string;
}

/**
 * YouTube-style action row: Like / Share / Save pill buttons under the
 * title. Visual presence is the goal — the buttons make the page feel
 * familiar at a glance even if half don't have a server-side backend yet.
 *
 *   - Like: local toggle persisted in localStorage. No backend; the count
 *           is single-user-perceived. Real "like" feed can wire later.
 *   - Share: copies the canonical URL to the clipboard with a toast.
 *   - Save: same model as Like (localStorage bookmark). Future feature
 *           can lift these into a customer-account-scoped "Watch later".
 *
 * The "fake-it-til-the-backend-exists" pattern is deliberate: shipping
 * the visual surface first lets us validate that creators like the
 * polished feel before we invest in server-side machinery.
 */
export default function ActionRow({ mediaId, mediaName }: ActionRowProps) {
  const { t } = useLocale();
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);

  // Hydrate liked + saved from localStorage on mount. SSR renders the
  // default "not liked / not saved" state so markup is consistent; we
  // refine it on the client after mount.
  useEffect(() => {
    try {
      setLiked(localStorage.getItem(`privapaid:liked:${mediaId}`) === "true");
      setSaved(localStorage.getItem(`privapaid:saved:${mediaId}`) === "true");
    } catch {
      // Storage disabled — fall through; buttons work as session-only toggles.
    }
  }, [mediaId]);

  function toggleLocal(
    key: "liked" | "saved",
    setter: (v: boolean | ((p: boolean) => boolean)) => void
  ) {
    setter((prev) => {
      const next = !prev;
      try {
        const storageKey = `privapaid:${key}:${mediaId}`;
        if (next) localStorage.setItem(storageKey, "true");
        else localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
      return next;
    });
  }

  async function handleShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    // Use the native Share API where available (mobile mostly) — falls
    // back to clipboard copy with a toast acknowledgement.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
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

  const pillClass =
    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors hover:opacity-90";
  const pillStyle = {
    backgroundColor: "var(--theme-bg-secondary)",
    color: "var(--theme-text)",
  };
  const activeStyle = {
    backgroundColor: "var(--theme-primary)",
    color: "var(--theme-bg)",
  };

  return (
    <div
      data-testid="action-row"
      className="mt-3 flex flex-wrap items-center gap-2"
    >
      <button
        onClick={() => toggleLocal("liked", setLiked)}
        data-testid="like-button"
        className={pillClass}
        style={liked ? activeStyle : pillStyle}
        aria-pressed={liked}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4.34-7.34A1 1 0 0 1 13 4l2 1.88z" />
        </svg>
        <span>{t("viewer.actions.like")}</span>
      </button>

      <button
        onClick={handleShare}
        data-testid="share-button"
        className={pillClass}
        style={pillStyle}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span>{t("viewer.actions.share")}</span>
      </button>

      <button
        onClick={() => toggleLocal("saved", setSaved)}
        data-testid="save-button"
        className={pillClass}
        style={saved ? activeStyle : pillStyle}
        aria-pressed={saved}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
