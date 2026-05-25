import "@testing-library/jest-dom/vitest";

// DATABASE_URL must be set BEFORE `@/lib/prisma` (or any module that imports
// it) loads — the PrismaClient singleton reads the env var at construction.
// `TEST_DATABASE_URL` is an explicit override; otherwise we point at the
// Postgres that `tests/helpers/postgres.ts` boots (testcontainer or local).
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  "postgresql://privapaid:privapaid@localhost:5432/privapaid_test?schema=public";

// Test environment variables
process.env.SK_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.AUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
process.env.NEXTAUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
process.env.NEXTAUTH_URL = "http://localhost:3000";
process.env.SATSRAIL_WEBHOOK_SECRET = "test-webhook-secret";
process.env.SATSRAIL_API_URL = "https://satsrail.com/api/v1";
