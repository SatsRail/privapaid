# Prisma — PrivaPaid Stream

PostgreSQL schema for PrivaPaid Stream.

## Local setup

1. **Run Postgres locally.** Easiest:
   ```bash
   docker run --name privapaid-pg -e POSTGRES_PASSWORD=privapaid \
     -e POSTGRES_USER=privapaid -e POSTGRES_DB=privapaid \
     -p 5432:5432 -d postgres:16-alpine
   ```

2. **Add to `.env.local`:**
   ```
   DATABASE_URL="postgresql://privapaid:privapaid@localhost:5432/privapaid?schema=public&connection_limit=20"
   ```

3. **Generate the Prisma client and apply migrations:**
   ```bash
   npm install            # postinstall runs `prisma generate`
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
  cron-triggered endpoint at `POST /api/internal/cleanup`.
- **Binary storage:** Photo bytes live in `EncryptedPhotoBlob` (bytea column)
  and smaller blobs (`profileImageBytes`, `thumbnailBytes`, `logoBytes`) are
  stored inline. High-volume operators may eventually want to move these to S3.
