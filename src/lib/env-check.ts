/**
 * Validates required environment variables on startup.
 * Called from instrumentation.ts so the app fails fast with clear errors.
 */

const REQUIRED_VARS = [
  "DATABASE_URL",
  "SK_ENCRYPTION_KEY",
] as const;

const REQUIRED_WITH_AUTH = [
  "NEXTAUTH_SECRET",
] as const;

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  // AUTH_SECRET or NEXTAUTH_SECRET — either works
  const hasAuthSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!hasAuthSecret) {
    missing.push(REQUIRED_WITH_AUTH[0] + " (or AUTH_SECRET)");
  }

  // SK_ENCRYPTION_KEY format: should be 64 hex chars (32 bytes)
  const skKey = process.env.SK_ENCRYPTION_KEY;
  if (skKey && !/^[0-9a-f]{64}$/i.test(skKey)) {
    console.error(
      "FATAL: SK_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required environment variables:\n  ${missing.join("\n  ")}\n\nSee .env.local.example for reference.`
    );
    process.exit(1);
  }
}
