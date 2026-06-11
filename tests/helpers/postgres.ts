import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { prisma } from "@/lib/prisma";

let container: StartedPostgreSqlContainer | undefined;
let pushed = false;

/**
 * Boot a Postgres for the test suite (idempotent across files within a worker).
 *
 * Resolution order for the connection URL:
 *   1. `TEST_DATABASE_URL` env var (or `DATABASE_URL`) — explicit override,
 *      fastest in CI/dev when a Postgres is already running (docker compose,
 *      brew services, Postgres.app).
 *   2. Docker via `@testcontainers/postgresql` — fully isolated fallback.
 *
 * `tests/setup.ts` pins DATABASE_URL before the Prisma client loads, so the
 * `prisma` singleton from `@/lib/prisma` is already pointed at the right DB
 * by the time this runs. We just ensure the schema is pushed once per worker.
 */
export async function setupTestDB(): Promise<void> {
  if (pushed) return; // idempotent

  let url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  if (!url || url.includes("localhost:5432/privapaid_test")) {
    // Default placeholder — try the placeholder first; if it isn't reachable,
    // fall back to testcontainers.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      try {
        container = await new PostgreSqlContainer("postgres:16-alpine")
          .withDatabase("privapaid_test")
          .withUsername("test")
          .withPassword("test")
          .start();
        url = container.getConnectionUri();
        // Reconnect Prisma to the new URL.
        await prisma.$disconnect();
        process.env.DATABASE_URL = url;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).prisma;
        const { PrismaClient } = await import("@prisma/client");
        const fresh = new PrismaClient({ datasources: { db: { url } } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).prisma = fresh;
      } catch (err) {
        throw new Error(
          "No reachable Postgres for tests. Either start one (docker compose " +
            "up -d postgres / brew services start postgresql@16) and set " +
            "TEST_DATABASE_URL, or start Docker Desktop so testcontainers can " +
            "spin up its own.\n\nUnderlying: " +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
  }

  // Apply Prisma schema to the DB. `db push` for speed — tests don't need
  // migration history, just a schema-matching DB.
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "pipe",
  });

  // `db push` renders schema.prisma only — CHECK constraints that live in raw
  // migration SQL are invisible to it. Re-apply the ones tests rely on so the
  // test DB enforces what production enforces.
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'MediaEnvelope_linked_has_wrappedDek'
      ) THEN
        ALTER TABLE "MediaEnvelope" ADD CONSTRAINT "MediaEnvelope_linked_has_wrappedDek"
          CHECK ("mediaId" IS NULL OR "wrappedDek" IS NOT NULL) NOT VALID;
      END IF;
    END $$;
  `);

  pushed = true;
}

export async function teardownTestDB(): Promise<void> {
  if (container) {
    await prisma.$disconnect();
    await container.stop();
    container = undefined;
  }
  pushed = false;
}

/**
 * Truncate every table, restarting identity columns, in one statement.
 * Much faster than per-table deletes and side-steps FK ordering.
 *
 * Wrapped in a serializable transaction with an advisory lock so parallel
 * vitest workers can't deadlock on cross-table AccessExclusiveLocks.
 */
export async function clearCollections(): Promise<void> {
  const tables: { tablename: string }[] = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations')
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$transaction(async (tx) => {
    // Single advisory lock for the truncate phase — collapses cross-worker
    // TRUNCATE deadlocks into clean serial waits.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  });
}

export function getTestPrisma() {
  return prisma;
}
