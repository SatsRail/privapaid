# Prisma — PrivaPaid Stream

PostgreSQL schema for PrivaPaid Stream. Migration from MongoDB/Mongoose is in
progress — see [`/Users/rafael/.claude/plans/privapaid-app-uses-mongodb-we-precious-harbor.md`](../../../.claude/plans/privapaid-app-uses-mongodb-we-precious-harbor.md)
(local) for the full plan.

## Local setup

1. **Run a Postgres locally.** Easiest:
   ```bash
   docker run --name privapaid-pg -e POSTGRES_PASSWORD=privapaid \
     -e POSTGRES_USER=privapaid -e POSTGRES_DB=privapaid \
     -p 5432:5432 -d postgres:16-alpine
   ```

2. **Add to `.env.local`** (alongside the existing `MONGODB_URI` for now —
   the codebase is mid-migration and both DBs run side-by-side):
   ```
   DATABASE_URL="postgresql://privapaid:privapaid@localhost:5432/privapaid?schema=public&connection_limit=20"
   ```

3. **Generate the Prisma client and apply the initial migration:**
   ```bash
   npm install            # postinstall runs `prisma generate`
   npm run db:migrate -- --name init
   ```

   This creates `prisma/migrations/<timestamp>_init/migration.sql` with the
   full schema. Commit it.

4. **Apply the Settings singleton check constraint** by adding a follow-up
   migration:
   ```bash
   npm run db:migrate -- --create-only --name settings_singleton
   ```
   Edit the generated `migration.sql` to contain:
   ```sql
   ALTER TABLE "Settings"
     ADD CONSTRAINT "Settings_singleton" CHECK (id = 1);
   ```
   Then apply it:
   ```bash
   npm run db:migrate
   ```

## Production

`Dockerfile` runs `prisma generate` in the build stage; `docker-entrypoint.sh`
runs `npm run db:deploy` before starting the app.

## Conventions

- **IDs:** `cuid()` (~25-char URL-safe). The numeric `ref` on Channel/Media is
  separate — that's the external-facing identifier used by the SatsRail portal
  (`ch_<ref>`, `md_<ref>`) and is generated atomically via the `Counter` table.
- **Field naming:** camelCase in Prisma, camelCase columns in Postgres (no
  `@map` — Prisma defaults).
- **Timestamps:** `createdAt @default(now())` + `updatedAt @updatedAt` on all
  models.
- **Soft deletes:** `deletedAt DateTime?` on Channel, Customer, Media. Filter
  with `where: { deletedAt: null }` everywhere user-visible.
- **TTL replacement:** AuditLog (90d) and WebhookEvent (7d) are deleted by a
  cron-triggered endpoint at `POST /api/internal/cleanup` (added in a later
  phase).
- **Binary storage:** GridFS replaced by `Bytes` columns
  (`profileImageBytes`, `thumbnailBytes`, `logoBytes`) and dedicated tables
  (`PreviewImage`, `EncryptedPhotoBlob`). High-volume operators will eventually
  want to move these to S3 — out of scope for now.
