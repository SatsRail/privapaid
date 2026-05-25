/**
 * @deprecated Kept as a no-op during the MongoDB→Postgres migration.
 *
 * Prisma auto-connects on first query. Existing `await connectDB()` calls in
 * route handlers are now harmless. This file will be deleted in the final
 * sweep once every callsite has been removed. Do NOT add new calls.
 */
export async function connectDB(): Promise<void> {
  // intentional no-op
}
