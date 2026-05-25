import { prisma } from "@/lib/prisma";

/**
 * Atomically increment and return the next sequence value for a given counter.
 * Creates the counter row if it doesn't exist. Single Postgres UPSERT with
 * { increment: 1 } — atomic at READ COMMITTED.
 *
 * Used by Channel.ref and Media.ref generation; matches the Mongoose API the
 * codebase already calls so call sites don't change.
 */
export async function getNextRef(name: string): Promise<number> {
  const counter = await prisma.counter.upsert({
    where: { id: name },
    create: { id: name, seq: 1 },
    update: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return counter.seq;
}
