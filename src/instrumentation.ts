export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");

    const { validateEnv } = await import("@/lib/env-check");
    validateEnv();

    // Trial-decrypt the stored merchant key against SK_ENCRYPTION_KEY.
    // Skipped in test runs (vitest setup creates fresh memory Mongo).
    if (process.env.NODE_ENV !== "test") {
      const { checkEncryptionKeyMatchesDb } = await import(
        "@/lib/startup-checks"
      );
      await checkEncryptionKeyMatchesDb();
    }

    // Opt-in distributed rate limiting. Without REDIS_URL the in-memory
    // store stays active (fine for a single-process deploy).
    if (process.env.REDIS_URL) {
      const { installRedisRateLimitStoreFromEnv } = await import(
        "@/lib/rate-limit-redis"
      );
      await installRedisRateLimitStoreFromEnv();
    }

    // OpenTelemetry — opt-in via OTEL_EXPORTER_OTLP_ENDPOINT env var
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const { getNodeAutoInstrumentations } = await import(
        "@opentelemetry/auto-instrumentations-node"
      );
      const { OTLPTraceExporter } = await import(
        "@opentelemetry/exporter-trace-otlp-http"
      );
      const { OTLPMetricExporter } = await import(
        "@opentelemetry/exporter-metrics-otlp-http"
      );
      const { PeriodicExportingMetricReader } = await import(
        "@opentelemetry/sdk-metrics"
      );

      const sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME || "privapaid",
        traceExporter: new OTLPTraceExporter(),
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 60_000,
        }),
        instrumentations: [
          getNodeAutoInstrumentations({
            "@opentelemetry/instrumentation-fs": { enabled: false },
          }),
        ],
      });

      sdk.start();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
