import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let container: StartedPostgreSqlContainer | undefined;
let prismaInstance: PrismaClient | undefined;

export async function setupTestDB(): Promise<void> {
  if (container) return; // idempotent
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("privapaid_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;

  // Apply Prisma schema to the container's DB. Uses `db push` for speed —
  // tests don't need the migration history, just a schema-matching DB.
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  prismaInstance = new PrismaClient({ datasources: { db: { url } } });
  await prismaInstance.$connect();
  // Make this instance the global one so app code (`@/lib/prisma`) sees it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).prisma = prismaInstance;
}

export async function teardownTestDB(): Promise<void> {
  await prismaInstance?.$disconnect();
  prismaInstance = undefined;
  await container?.stop();
  container = undefined;
}

/**
 * Truncate every table, restarting identity columns, in one statement.
 * Much faster than per-table deletes and side-steps FK ordering.
 */
export async function clearCollections(): Promise<void> {
  if (!prismaInstance) throw new Error("setupTestDB must be called first");
  const tables: { tablename: string }[] = await prismaInstance.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations')
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prismaInstance.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`
  );
}

export function getTestPrisma(): PrismaClient {
  if (!prismaInstance) throw new Error("setupTestDB must be called first");
  return prismaInstance;
}
