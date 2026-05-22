import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Sentry init contract.
 *
 * sentry.client.config.ts gates Sentry on `!!process.env.NEXT_PUBLIC_SENTRY_DSN`.
 * If the build doesn't inline the DSN, that boolean is false and EVERY
 * captureException/captureMessage call in the app becomes a silent no-op.
 * That is exactly the observability gap that left the article failure
 * undiagnosable in production.
 *
 * This file pins the contract at the module level: the config MUST set
 * `enabled: true` when the DSN is present, and `enabled: false` when it
 * is not. The build-time inlining itself is verified separately by
 * scripts/verify-sentry-dsn-inlined.sh (a real `next build` smoke test).
 */

vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
}));

describe("sentry.client.config.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  it("enables Sentry when NEXT_PUBLIC_SENTRY_DSN is set", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN =
      "https://abc123@o4510882343354368.ingest.us.sentry.io/4511095878975488";

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        enabled: true,
      })
    );
  });

  it("disables Sentry when NEXT_PUBLIC_SENTRY_DSN is missing", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it("disables Sentry when NEXT_PUBLIC_SENTRY_DSN is empty string (Docker default)", async () => {
    // The Dockerfile declares `ARG NEXT_PUBLIC_SENTRY_DSN=""`. If the
    // docker-compose build doesn't pass a value through, the bundle is
    // built with the empty string. The runtime check must catch that
    // case explicitly — `!!""` is false, so this should be disabled.
    process.env.NEXT_PUBLIC_SENTRY_DSN = "";

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it("passes the environment to Sentry.init", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://x@y.ingest.sentry.io/1";

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ environment: process.env.NODE_ENV })
    );
  });
});

describe("sentry.server.config.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  it("enables Sentry when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://abc123@o4510882343354368.ingest.us.sentry.io/4511095878975488";

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.server.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it("disables Sentry when SENTRY_DSN is missing", async () => {
    delete process.env.SENTRY_DSN;

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.server.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });
});
