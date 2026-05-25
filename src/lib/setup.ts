import { prisma } from "@/lib/prisma";

// Always check Postgres directly — no in-memory caching.
// All pages use force-dynamic, so fresh reads are expected.
export async function isSetupComplete(): Promise<boolean> {
  const settings = await prisma.settings.findFirst({
    where: { setupCompleted: true },
    select: { id: true },
  });
  return !!settings;
}

// No-op: caching was removed but callers still reference this.
export function clearSetupCache(): void {
  /* intentional no-op */
}
