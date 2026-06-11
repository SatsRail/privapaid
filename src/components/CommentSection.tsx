"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/useLocale";

interface Comment {
  id: string;
  body: string;
  created_at: string;
}

interface CommentSectionProps {
  mediaId: string;
  hasAccess: boolean;
  onUnauthorized?: () => void;
}

export default function CommentSection({ mediaId, hasAccess, onUnauthorized }: CommentSectionProps) {
  const { t } = useLocale();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/media/${mediaId}/comments`, { cache: "no-store" });
      if (!res.ok) throw new Error("load");
      const json = await res.json();
      setComments(json.data ?? []);
    } catch {
      // Soft-fail: empty list is fine for an unloved media item.
    } finally {
      setLoading(false);
    }
  }, [mediaId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/media/${mediaId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.status === 401) {
        onUnauthorized?.();
        setError(t("viewer.comments.payment_required"));
        return;
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || t("viewer.comments.post_failed"));
        return;
      }
      const created: Comment = await res.json();
      setComments((prev) => [created, ...prev]);
      setBody("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-lg font-semibold">{t("viewer.comments.heading")}</h2>

      {hasAccess ? (
        <form onSubmit={handleSubmit} className="mb-6">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder={t("viewer.comments.body_placeholder")}
            className="w-full rounded-md border p-2"
            style={{
              backgroundColor: "var(--theme-bg-secondary)",
              borderColor: "var(--theme-border)",
              color: "var(--theme-text)",
            }}
          />
          {error && (
            <p className="mt-1 text-sm" style={{ color: "var(--theme-text-secondary)" }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !body.trim()}
            className="mt-2 rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
            style={{ backgroundColor: "var(--theme-primary)", color: "var(--theme-bg, #000)" }}
          >
            {submitting ? t("viewer.comments.posting") : t("viewer.comments.post")}
          </button>
        </form>
      ) : (
        <p className="mb-6 text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          {t("viewer.comments.paywall_message")}
        </p>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          {t("common.loading")}
        </p>
      ) : comments.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          {t("viewer.comments.empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="rounded-md p-3"
              style={{ backgroundColor: "var(--theme-bg-secondary)" }}
            >
              <p className="whitespace-pre-wrap text-sm">{c.body}</p>
              <p className="mt-1 text-xs" style={{ color: "var(--theme-text-secondary)" }}>
                {new Date(c.created_at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
