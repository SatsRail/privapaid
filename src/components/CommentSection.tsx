"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import Button from "@/components/ui/Button";
import { useLocale } from "@/i18n/useLocale";
import { formatTimeAgo } from "@/lib/relative-time";
import Skeleton from "@/components/Skeleton";

interface Comment {
  _id: string;
  body: string;
  created_at: string;
  customer: { nickname: string };
}

interface CommentSectionProps {
  mediaId: string;
  productIds: string[];
  /**
   * Whether the viewer has active paid access for this media. The parent
   * (MediaLayout) owns the single `useMediaAccess` hook and derives this
   * from `access.status === "active"`. CommentSection used to run its own
   * macaroon verification and listen for unlock events — both removed in
   * favor of this prop so all components stay in sync.
   */
  hasAccess: boolean;
  /**
   * Called when a server-side write returns 401/402, signaling that the
   * cached access view is stale. Parent re-runs `useMediaAccess.refresh()`
   * to reconcile.
   */
  onUnauthorized?: () => void;
}

const NICKNAME_KEY = "privapaid_nickname";

export default function CommentSection({
  mediaId,
  productIds,
  hasAccess,
  onUnauthorized,
}: CommentSectionProps) {
  const { data: session } = useSession();
  const { t, locale } = useLocale();
  const { data: comments, mutate, isLoading } = useSWR<Comment[]>(
    `/api/media/${mediaId}/comments`,
    fetcher
  );
  // `comments` is undefined while loading; default to [] for downstream code
  // that depends on it being an array. Loading state is tracked separately
  // so we can render skeleton placeholders instead of "no comments yet."
  const commentsList = comments ?? [];
  const [body, setBody] = useState("");
  const [nickname, setNickname] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isCustomer = session?.user?.role === "customer";

  // Load saved nickname from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NICKNAME_KEY);
      if (saved) setNickname(saved);
    } catch {
      // localStorage not available
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;

    // Anonymous payers need a nickname
    if (!isCustomer && !nickname.trim()) {
      setError(t("viewer.comments.nickname_required"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const payload: { body: string; nickname?: string } = { body: body.trim() };
      if (nickname.trim()) {
        payload.nickname = nickname.trim();
      }

      const res = await fetch(`/api/media/${mediaId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        // Server says access is missing/expired even though we optimistically
        // showed the form. Surface a clearer error and ask the parent to
        // re-check access (which will hide the form via the hasAccess prop
        // if access really is gone).
        if (res.status === 401 || res.status === 402) {
          setError(t("viewer.comments.access_unverified"));
          onUnauthorized?.();
          return;
        }
        setError(json.error || "Failed to post comment");
        return;
      }

      // Save nickname for future use
      if (nickname.trim()) {
        try {
          localStorage.setItem(NICKNAME_KEY, nickname.trim());
        } catch {
          // localStorage not available
        }
      }

      mutate([json, ...commentsList], false);
      setBody("");
    } catch {
      setError(t("viewer.comments.error"));
    } finally {
      setLoading(false);
    }
  }

  const canComment = isCustomer || hasAccess;

  return (
    <div
      className="mt-8 border-t pt-6"
      style={{ borderColor: "var(--theme-border)" }}
    >
      {/* YouTube's comments heading: 16px (text-base) at weight 700 (bold).
          The count + "Comments" string read as a single solid label rather
          than a soft heading. */}
      <h3
        className="mb-4 text-base font-bold"
        style={{ color: "var(--theme-heading)" }}
      >
        {t("viewer.comments.title", { count: commentsList.length })}
      </h3>

      {canComment && productIds.length > 0 ? (
        <CommentForm
          isCustomer={isCustomer}
          nickname={nickname}
          setNickname={setNickname}
          body={body}
          setBody={setBody}
          loading={loading}
          error={error}
          onSubmit={handleSubmit}
          t={t}
        />
      ) : productIds.length > 0 ? (
        <p
          className="mb-6 text-sm"
          style={{ color: "var(--theme-text-secondary)" }}
        >
          {t("viewer.comments.paywall_message")}
        </p>
      ) : null}

      {isLoading ? (
        // Skeleton row mirrors the real comment shape: 40px avatar + a
        // narrow author line + a wider body line. Three rows hint at
        // multiple incoming comments without committing to a count.
        <div className="flex flex-col gap-4" data-testid="comment-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : commentsList.length > 0 ? (
        <div className="flex flex-col gap-4">
          {commentsList.map((c) => {
            // Anonymous-user style avatar: 40px circle, first letter of the
            // nickname inside. Exactly the pattern YouTube uses for users
            // without a custom avatar. Falls back to "?" for empty nicknames.
            const avatarInitial =
              c.customer.nickname.trim().charAt(0).toUpperCase() || "?";
            return (
              <div key={c._id} className="flex gap-3" data-testid="comment-item">
                <div
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium"
                  style={{
                    backgroundColor: "var(--theme-bg-secondary)",
                    color: "var(--theme-text)",
                  }}
                  aria-hidden="true"
                >
                  {avatarInitial}
                </div>
                <div className="min-w-0 flex-1">
                  {/* Author + timestamp row. Exact YouTube sizing:
                        - Author: 13px, weight 500 (medium)
                        - Timestamp: 12px (text-xs), weight 400, muted color */}
                  <div className="mb-1 flex items-baseline gap-2">
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: "var(--theme-text)" }}
                    >
                      {c.customer.nickname}
                    </span>
                    <span
                      className="text-xs"
                      style={{ color: "var(--theme-text-secondary)" }}
                    >
                      {/* YouTube-style relative time ("3 days ago") instead
                          of an absolute date — matches the engagement-
                          oriented framing where freshness signals matter. */}
                      {formatTimeAgo(c.created_at, locale)}
                    </span>
                  </div>
                  {/* Body: 14px (text-sm), weight 400, line-height 1.43 —
                      the comfortable reading rhythm YouTube uses. */}
                  <p
                    className="text-sm leading-[1.43] whitespace-pre-wrap"
                    style={{ color: "var(--theme-text)" }}
                  >
                    {c.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          {t("viewer.comments.empty")}
        </p>
      )}
    </div>
  );
}

/**
 * YouTube-style comment form. Borderless inputs with a bottom-only border
 * that thickens on focus. Action buttons (Cancel + Comment) only render
 * when the user has actually engaged with the textarea — the default
 * idle state is just a placeholder line, no UI noise.
 */
function CommentForm({
  isCustomer,
  nickname,
  setNickname,
  body,
  setBody,
  loading,
  error,
  onSubmit,
  t,
}: {
  isCustomer: boolean;
  nickname: string;
  setNickname: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  loading: boolean;
  error: string;
  onSubmit: (e: React.FormEvent) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [focused, setFocused] = useState(false);

  // Buttons are visible when the user is engaging (focused) OR has typed
  // anything. Otherwise the input sits as a single quiet line — YouTube's
  // exact pattern.
  const showActions = focused || body.length > 0;

  const inputBase =
    "block w-full bg-transparent text-sm focus:outline-none transition-colors";
  // border-b-2 default invisible; on focus, theme-primary turns it on.
  const inputStyle: React.CSSProperties = {
    color: "var(--theme-text)",
  };

  return (
    <form onSubmit={onSubmit} className="mb-6 flex gap-3">
      {/* Avatar mirror — gives the form the same left-rail alignment as
          rendered comments below. Slightly muted to read as "your seat". */}
      <div
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium"
        style={{
          backgroundColor: "var(--theme-bg-secondary)",
          color: "var(--theme-text-secondary)",
        }}
        aria-hidden="true"
      >
        {(isCustomer ? "" : nickname.trim().charAt(0).toUpperCase()) || "?"}
      </div>

      <div className="min-w-0 flex-1">
        {!isCustomer && (
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onFocus={() => setFocused(true)}
            placeholder={t("viewer.comments.nickname_placeholder")}
            maxLength={30}
            className={`${inputBase} mb-3 border-b py-1`}
            style={{
              ...inputStyle,
              borderColor: focused ? "var(--theme-primary)" : "var(--theme-border)",
            }}
          />
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder={t("viewer.comments.body_placeholder")}
          rows={focused || body ? 3 : 1}
          maxLength={2000}
          className={`${inputBase} border-b py-1 resize-none`}
          style={{
            ...inputStyle,
            borderColor: focused ? "var(--theme-primary)" : "var(--theme-border)",
            borderBottomWidth: focused ? "2px" : "1px",
          }}
        />
        {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
        {showActions && (
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setBody("");
                setFocused(false);
              }}
              className="rounded-full px-3 py-1.5 text-sm font-medium hover:bg-[var(--theme-bg-secondary)]"
              style={{ color: "var(--theme-text)" }}
            >
              {t("viewer.comments.cancel")}
            </button>
            <Button type="submit" size="sm" loading={loading}>
              {t("viewer.comments.post")}
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
