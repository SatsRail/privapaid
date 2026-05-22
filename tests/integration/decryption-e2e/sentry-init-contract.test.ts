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
    delete (globalThis as { window?: unknown }).window;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete (globalThis as { window?: unknown }).window;
  });

  it("prefers the runtime DSN from window.__INSTANCE_CONFIG__ over the build-time env var", async () => {
    // The admin Settings UI writes the DSN into MongoDB; the root layout
    // surfaces it as window.__INSTANCE_CONFIG__. That value wins over a
    // build-time fallback so operators can configure error reporting
    // without a Docker rebuild.
    const runtimeDsn = "https://runtime@o4510882343354368.ingest.us.sentry.io/4511095878975488";
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://buildtime@y.ingest.sentry.io/1";
    (globalThis as { window?: unknown }).window = {
      __INSTANCE_CONFIG__: { sentryDsn: runtimeDsn },
    };

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: runtimeDsn, enabled: true })
    );
  });

  it("falls back to NEXT_PUBLIC_SENTRY_DSN when no runtime config is present", async () => {
    const buildDsn = "https://buildtime@o4510882343354368.ingest.us.sentry.io/4511095878975488";
    process.env.NEXT_PUBLIC_SENTRY_DSN = buildDsn;
    (globalThis as { window?: unknown }).window = {
      __INSTANCE_CONFIG__: { sentryDsn: "" }, // runtime empty
    };

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: buildDsn, enabled: true })
    );
  });

  it("disables Sentry when neither runtime config nor env var is set", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    (globalThis as { window?: unknown }).window = {
      __INSTANCE_CONFIG__: { sentryDsn: "" },
    };

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it("disables Sentry when both runtime config and env var are empty strings", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "";
    (globalThis as { window?: unknown }).window = {
      __INSTANCE_CONFIG__: { sentryDsn: "" },
    };

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it("handles a missing window (server-side import) by falling back to env", async () => {
    const buildDsn = "https://buildtime@o4510882343354368.ingest.us.sentry.io/4511095878975488";
    process.env.NEXT_PUBLIC_SENTRY_DSN = buildDsn;
    // No window — simulates server-side / module load before hydration.

    const Sentry = await import("@sentry/nextjs");
    await import("../../../sentry.client.config");

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: buildDsn, enabled: true })
    );
  });

  it("passes NODE_ENV as the environment tag", async () => {
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
