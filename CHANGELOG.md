# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed (licensing)

- **License switched from MIT to FSL-1.1-ALv2** ([Functional Source License](https://fsl.software/),
  version 1.1, Apache 2.0 future grant). PrivaPaid remains source-available
  and free to self-host, fork, modify, and use commercially — including for
  client work and internal deployments. The license restricts only **Competing
  Use**: offering PrivaPaid as a hosted product or service that substitutes
  for SatsRail's offering. Two years after each release, that release
  additionally becomes available under Apache 2.0. See [LICENSE](LICENSE) for
  the full text.

### Removed (breaking)

- **Customer account feature removed.** Nickname-based customer login, the
  storefront favorites UI, the per-customer flags feature, and the customer
  purchase history are gone. Payment + decryption flow is macaroon-only:
  anonymous buyers pay via Lightning, the macaroon issued by SatsRail is the
  proof of purchase. Removed models: `Customer`, `Purchase`, `Flag`, plus the
  implicit `_CustomerFavorites` join. Removed routes: `/api/customer/*`,
  `/api/media/[id]/flags`. Removed pages: `/login` is now admin-only;
  `/signup` and `/profile` are gone. Removed Media counter: `flagsCount`.
  Removed enum value: `AuditActorType.customer`. The `/login` page no longer
  accepts nickname — email + password only (staff auth via SatsRail).
  **Migration**: existing customer data is dropped; if you need to preserve
  purchases for an export, do so before applying this version's schema.
  Macaroon-based access for paying viewers is unaffected.

### Changed

- **Comments are now anonymous.** The `Comment` model no longer tracks a
  nickname or a customer reference — body and timestamp only. The POST
  route at `/api/media/[id]/comments` remains macaroon-gated (paying viewers
  can post; anyone can read).

### Changed (breaking)

- **Database migrated from MongoDB to PostgreSQL.** Mongoose → Prisma across the
  whole codebase. Field names converted from snake_case to camelCase
  (`created_at` → `createdAt`, `_id` → `id`, etc.). Primary key shape changed
  from 24-char ObjectId hex to ~25-char cuid string. Embedded arrays
  (`Customer.purchases`, `ChannelProduct.encrypted_media`,
  `Customer.favorite_channel_ids`) became dedicated tables (`Purchase`,
  `ChannelProductMedia`, M2M `CustomerFavorites`).
- **Binary storage replaced GridFS with `bytea` columns.** Channel profile
  images, media thumbnails, and the instance logo now live in `Bytes` columns
  on their owning rows. Preview images and encrypted photo blobs each get a
  dedicated table (`PreviewImage`, `EncryptedPhotoBlob`). `Media.sourceUrl`
  for photo media stores an `EncryptedPhotoBlob.id` rather than a GridFS file
  id; encryption envelope is byte-identical (`Base64(IV[12]+ct+tag[16])`).
- **TTL indexes replaced by app cron.** AuditLog (90d) and WebhookEvent (7d)
  cleanup moved to `POST /api/internal/cleanup`, gated by `CLEANUP_SECRET`
  bearer auth and scheduled by the deploy platform.
- **Env var rename:** `MONGODB_URI` → `DATABASE_URL`. All `MONGO_*` vars
  removed. `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` added for
  docker-compose.
- **Health endpoint shape:** `body.mongo` → `body.db`.
- **Test infrastructure:** `mongodb-memory-server` → `@testcontainers/postgresql`.

### Removed

- `mongoose` and `mongodb-memory-server` deps
- `src/lib/mongodb.ts`, `src/lib/gridfs.ts`, `src/lib/logo.ts`
- All 12 Mongoose model files under `src/models/` (Counter.ts kept as a thin
  Prisma helper preserving the `getNextRef(name)` signature)
- `scripts/backfill-photo-deks.ts` (one-time legacy backfill; no longer needed)
- `docker/mongo-init.js` and the `mongo` service in `docker-compose.yml`

### Added

- `prisma/schema.prisma` covering all 13 models with cuid IDs, citext indexes
  for case-insensitive uniques, soft-delete `deletedAt` columns, denormalized
  counters preserved, and a singleton `Settings` row enforced by check
  constraint.
- `src/lib/prisma.ts` global singleton (hot-reload safe).
- `tests/helpers/postgres.ts` testcontainer harness with TRUNCATE-based reset.
- `src/app/api/internal/cleanup/route.ts` cron-driven TTL replacement.
- `src/lib/image-constants.ts` extracted from the deleted `gridfs.ts`.
- `npm run db:migrate` / `db:deploy` / `db:studio` scripts.

## [0.9.0] - 2026-03-20

### Added

- **SWR client-side data caching** — comments, exchanges, products, and product types now use SWR for automatic caching and deduplication (F-42)
- **Rate limiting** on public endpoints: signup (5/min), checkout (20/min), comments (10/min), image upload (30/min) with `X-RateLimit-*` headers (F-33)
- **Soft-delete** support for Media, Channel, and Customer models with `deleted_at` field (F-36)
- **EXIF metadata stripping** on all image uploads via Sharp (F-29)
- **Modal accessibility** — ARIA roles, focus trapping, focus restoration, keyboard navigation (F-32)
- **i18n pluralization** — `_zero`, `_one`, `_other` suffix support in `t()` function (F-30)
- **Loading states** — `loading.tsx` skeleton loaders for root, admin, and channel routes (F-41)
- **Zod request validation** on all POST/PATCH/PUT API routes (F-11, F-27)
- **OpenAPI 3.0.3 spec** with Swagger UI at `/api-docs` (F-23)
- **Branded types** for encryption keys with runtime format validation (F-35)
- **CONTRIBUTING.md**, PR template, and issue templates (F-43)
- **CHANGELOG.md** and semantic versioning (F-44)
- **Docker resource limits** — memory and CPU caps on app and MongoDB containers (F-39)
- **BuildKit cache mounts** for faster Docker builds (F-45)

### Changed

- **Auth forms refactored** — shared components extracted to `src/components/auth/` reducing ~40% duplication (F-31)
- **Consistent timestamps** — `updated_at` enabled on all Mongoose models (F-34)
- Package renamed from `media` to `privapaid`, version bumped to 0.9.0

### Removed

- Unused `hello_controller.js` scaffold (F-47)

### Security

- CSRF protection via SameSite cookies and origin validation (F-01)
- HttpOnly session cookies with Secure flag (F-02)
- Content Security Policy headers (F-03)
- MongoDB injection prevention via Mongoose strict mode (F-04)
- Input length limits on all text fields (F-05)
- File upload validation (type, size, dimensions) (F-06)
- Secrets moved to environment variables (F-07)
- Admin session timeout (F-08)
- Audit logging for admin actions (F-09)

## [0.1.0] - 2026-03-01

### Added

- Initial PrivaPaid platform
- Next.js App Router with MongoDB/Mongoose
- Customer signup/login with NextAuth
- Admin panel for channels, media, categories, and products
- Lightning payment integration via SatsRail API
- Macaroon-based content access control
- Image upload to Cloudinary
- i18n support (English, Spanish)
- Docker deployment configuration
