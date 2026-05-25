/**
 * Seed script to create the initial owner.
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts admin@example.com "Admin Name" password123
 *
 * Or via env vars:
 *   ADMIN_EMAIL=admin@example.com ADMIN_NAME="Admin" ADMIN_PASSWORD=password123 npx tsx scripts/seed-admin.ts
 *
 * Requires DATABASE_URL in .env.local or environment.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Check .env.local");
  process.exit(1);
}

const email = process.argv[2] || process.env.ADMIN_EMAIL;
const name = process.argv[3] || process.env.ADMIN_NAME || "Superadmin";
const password = process.argv[4] || process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error(
    "Usage: npx tsx scripts/seed-admin.ts <email> <name> <password>"
  );
  process.exit(1);
}

async function seed() {
  console.log("Connected to Postgres via Prisma");

  const existing = await prisma.admin.findUnique({ where: { email: email! } });
  if (existing) {
    console.log(`Admin with email ${email} already exists. Skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password!, 12);

  await prisma.admin.create({
    data: {
      email: email!,
      passwordHash,
      name,
      role: "owner",
      active: true,
    },
  });

  console.log(`Superadmin created: ${email}`);
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
