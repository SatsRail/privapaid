"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/i18n/useLocale";

interface ChannelBlockProps {
  name: string;
  slug: string;
  profileImageUrl?: string;
}

/**
 * YouTube-style channel attribution row that sits under the action row.
 * Avatar (40px) + channel name + "Subscribe" pill. Click avatar/name →
 * channel page. Click Subscribe → toggles a localStorage bookmark so the
 * user's "subscribed channels" persist across visits.
 *
 * The Subscribe button is intentionally a local-only bookmark for now —
 * no backend wiring, no server-side state. The visual presence is what
 * makes the page feel YouTube-shaped; we can add real subscription
 * mechanics later without changing the UI surface.
 */
export default function ChannelBlock({ name, slug, profileImageUrl }: ChannelBlockProps) {
  const { t } = useLocale();
  const [subscribed, setSubscribed] = useState(false);

  // Hydrate from localStorage on mount. SSR renders the default "not
  // subscribed" state so the markup is consistent; we flip after mount to
  // avoid an SSR/CSR mismatch.
  //
  // The setState call here trips React 19's `react-hooks/set-state-in-effect`
  // rule, which is overzealous for this case: we're synchronizing in-memory
  // state with an external store (localStorage) that has no change-event
  // subscription model. The "correct" alternative is `useSyncExternalStore`,
  // but it doesn't let us mutate the value too, which we need for the click
  // handler. Disabling the rule with an explicit justification is cleaner
  // than refactoring around it.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`privapaid:subscribed:${slug}`);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "true") setSubscribed(true);
    } catch {
      // Private mode / storage disabled — fall through, button works as a
      // session-only toggle.
    }
  }, [slug]);

  function toggleSubscribe() {
    setSubscribed((prev) => {
      const next = !prev;
      try {
        if (next) {
          localStorage.setItem(`privapaid:subscribed:${slug}`, "true");
        } else {
          localStorage.removeItem(`privapaid:subscribed:${slug}`);
        }
      } catch {
        // Ignore storage errors — UI state is the source of truth this session.
      }
      return next;
    });
  }

  // Channel initial fallback when no avatar is available — matches the
  // pattern in Sidebar/ChannelList for visual consistency.
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="mt-3 flex items-center justify-between gap-3"
      data-testid="channel-block"
    >
      <Link
        href={`/c/${slug}`}
        className="flex min-w-0 flex-1 items-center gap-3 group"
      >
        {profileImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profileImageUrl}
            alt={name}
            className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            style={{
              backgroundColor: "var(--theme-bg-secondary)",
              color: "var(--theme-text)",
            }}
          >
            {initial}
          </div>
        )}
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium group-hover:underline"
            style={{ color: "var(--theme-text)" }}
          >
            {name}
          </p>
        </div>
      </Link>
      <button
        onClick={toggleSubscribe}
        data-testid="subscribe-button"
        className="flex-shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors"
        style={{
          backgroundColor: subscribed
            ? "var(--theme-bg-secondary)"
            : "var(--theme-text)",
          color: subscribed
            ? "var(--theme-text)"
            : "var(--theme-bg)",
        }}
      >
        {subscribed
          ? t("viewer.channel.subscribed")
          : t("viewer.channel.subscribe")}
      </button>
    </div>
  );
}
