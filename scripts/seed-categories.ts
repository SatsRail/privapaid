/**
 * Seed script to create PrivaPaid categories.
 *
 * Usage:
 *   npx tsx scripts/seed-categories.ts
 *
 * Idempotent: skips categories whose slug already exists.
 * Requires DATABASE_URL in .env.local or environment.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { prisma } from "@/lib/prisma";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Check .env.local");
  process.exit(1);
}

// No default categories — merchants create their own from scratch.
// This script is kept as a reference for how to seed categories if needed.
const CATEGORIES: string[] = [];

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function seed() {
  console.log("Connected to Postgres via Prisma");

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < CATEGORIES.length; i++) {
    const name = CATEGORIES[i];
    const slug = toSlug(name);

    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) {
      console.log(`  skip: "${name}" (slug "${slug}" already exists)`);
      skipped++;
      continue;
    }

    await prisma.category.create({
      data: {
        name,
        slug,
        position: i,
        active: true,
      },
    });
    console.log(`  added: "${name}" → ${slug}`);
    inserted++;
  }

  console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
