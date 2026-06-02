"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/useLocale";
import { buttonClasses } from "@/components/ui/buttonStyles";
import { urlBase64ToUint8Array } from "@/lib/push-client";

interface NotifyButtonProps {
  channelSlug: string;
  /** VAPID public key, passed from the server component. */
  vapidPublicKey: string;
}

/**
 * Per-channel "Notify me of new content" control. Backed by anonymous Web Push:
 * on opt-in we register a service worker, create a browser PushSubscription
 * (an opaque per-device endpoint — no account, no email), and POST it scoped to
 * this channel. The endpoint is the only thing stored server-side; the privacy
 * note below the button discloses this.
 *
 * Subscription state for THIS channel lives in localStorage (the browser holds
 * one push endpoint shared across all channels it follows, so per-channel state
 * is client-tracked — same pattern ActionRow uses for like/dislike).
 *
 * Unsubscribe only deletes this channel's server row; it deliberately does NOT
 * call `sub.unsubscribe()`, which would kill push for every channel on this
 * browser.
 *
 * iOS Safari only exposes Web Push when the site is installed to the Home
 * Screen (PWA), so on an un-installed iOS tab we show an "Add to Home Screen"
 * hint instead of a dead button.
 */
type NotifyState =
  | "checking" // initial mount, deciding what to render
  | "unsupported" // no SW/Push support (non-iOS) — render nothing
  | "ios-hint" // iOS Safari not installed as PWA
  | "default" // supported, not subscribed to this channel
  | "denied" // browser permission denied
  | "working" // subscribe/unsubscribe in flight
  | "subscribed"; // subscribed to this channel

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export default function NotifyButton({
  channelSlug,
  vapidPublicKey,
}: NotifyButtonProps) {
  const { t } = useLocale();
  const [state, setState] = useState<NotifyState>("checking");
  const [toast, setToast] = useState<string | null>(null);

  const storageKey = `privapaid:notify:${channelSlug}`;

  // Decide the initial state on mount.
  useEffect(() => {
    if (!pushSupported()) {
      // iOS Safari only supports push once installed to the Home Screen.
      setState(isIOS() && !isStandalone() ? "ios-hint" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    let subscribedHere = false;
    try {
      subscribedHere = localStorage.getItem(storageKey) === "true";
    } catch {
      // Storage disabled — treat as not subscribed.
    }
    setState(
      subscribedHere && Notification.permission === "granted"
        ? "subscribed"
        : "default"
    );
  }, [storageKey]);

  function writeFlag(value: boolean) {
    try {
      if (value) localStorage.setItem(storageKey, "true");
      else localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

  function showToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  }

  async function subscribe() {
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "default");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      }

      const json = sub.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_slug: channelSlug,
          subscription: { endpoint: json.endpoint, keys: json.keys },
        }),
      });
      if (!res.ok) throw new Error(String(res.status));

      writeFlag(true);
      setState("subscribed");
    } catch {
      writeFlag(false);
      setState("default");
      showToast(t("viewer.notify.error"));
    }
  }

  async function unsubscribe() {
    setState("working");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const sub = await registration?.pushManager.getSubscription();
      // Only remove THIS channel's server row — keep the browser subscription
      // alive for any other channels this device follows.
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub?.endpoint,
          channel_slug: channelSlug,
        }),
      });
      writeFlag(false);
      setState("default");
    } catch {
      // Even on failure, drop the local flag so the UI reflects intent; the
      // server row self-prunes on the next failed send.
      writeFlag(false);
      setState("default");
    }
  }

  if (state === "checking" || state === "unsupported") return null;

  if (state === "ios-hint") {
    return (
      <p
        className="mt-3 text-xs"
        style={{ color: "var(--theme-text-secondary)" }}
      >
        {t("viewer.notify.ios_hint")}
      </p>
    );
  }

  const subscribed = state === "subscribed";
  const working = state === "working";
  const denied = state === "denied";

  const label = subscribed
    ? t("viewer.notify.subscribed")
    : working
      ? t("viewer.notify.working")
      : t("viewer.notify.subscribe");

  return (
    <div className="mt-3 flex flex-col gap-1">
      <button
        type="button"
        data-testid="notify-button"
        onClick={subscribed ? unsubscribe : subscribe}
        disabled={working || denied}
        aria-pressed={subscribed}
        className={buttonClasses({
          variant: subscribed ? "secondary" : "outline",
          size: "sm",
        })}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={subscribed ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span>{label}</span>
      </button>

      {denied && (
        <p className="text-xs" style={{ color: "var(--theme-text-secondary)" }}>
          {t("viewer.notify.denied")}
        </p>
      )}

      {/* Opt-in disclosure: shown before the viewer commits, hidden once on. */}
      {!subscribed && !denied && (
        <p className="text-xs" style={{ color: "var(--theme-text-secondary)" }}>
          {t("viewer.notify.disclosure")}
        </p>
      )}

      {toast && (
        <span
          role="status"
          className="text-xs"
          style={{ color: "var(--theme-text-secondary)" }}
        >
          {toast}
        </span>
      )}
    </div>
  );
}
