import * as Sentry from "@sentry/nextjs";
import { scrubEvent, scrubBreadcrumb } from "@/lib/sentry-scrub";

declare global {
  interface Window {
    /**
     * Public-safe runtime config emitted by the root layout. Lets operators
     * configure things like the Sentry DSN through the admin Settings UI
     * without rebuilding the Docker image.
     */
    __INSTANCE_CONFIG__?: { sentryDsn?: string };
  }
}

// Prefer the DB-backed runtime value (set via /admin/settings); fall back to
// the build-time env var so existing deploys keep working unchanged.
const dsn =
  (typeof window !== "undefined" && window.__INSTANCE_CONFIG__?.sentryDsn) ||
  process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  enabled: !!dsn,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
