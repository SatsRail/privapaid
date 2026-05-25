"use client";

import { useCallback, useEffect, useState } from "react";

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
        setError("Payment required to comment.");
        return;
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || "Failed to post comment.");
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
      <h2 className="mb-3 text-lg font-semibold">Comments</h2>

      {hasAccess ? (
        <form onSubmit={handleSubmit} className="mb-6">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Leave a comment…"
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
            {submitting ? "Posting…" : "Post"}
          </button>
        </form>
      ) : (
        <p className="mb-6 text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          Pay to unlock this content to leave a comment.
        </p>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          Loading…
        </p>
      ) : comments.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--theme-text-secondary)" }}>
          No comments yet.
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
