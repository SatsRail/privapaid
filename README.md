# PrivaPaid Stream

[![Tests](https://github.com/SatsRail/privapaid/actions/workflows/test.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/test.yml)
[![CodeQL](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/SatsRail/privapaid/branch/main/graph/badge.svg)](https://codecov.io/gh/SatsRail/privapaid)

Source-available, encryption-first content platform powered by [SatsRail](https://www.satsrail.com/) Bitcoin Lightning payments. Sell any type of media — video, audio, articles, photos, podcasts — with instant, non-custodial payments. No payment processor accounts, no chargebacks, no middlemen.

The buyer-facing copy of every piece of content is encrypted at rest, and decryption happens entirely in the buyer's browser after payment — the server never decrypts content for a buyer. SatsRail manages encryption keys and payment verification but never sees your content. PrivaPaid never touches customer funds.

A second copy of each item — the source URL for video/audio/podcast, the body text for articles, the wrapped DEK for photos — is persisted on the `Media` document so admins can re-encrypt after a key rotation without depending on SatsRail returning the old key. That plaintext copy is admin-only by route convention; no public endpoint returns it. See [docs/ENCRYPTION.md](docs/ENCRYPTION.md) § "Threat model" for the trade-off and mitigations.

Fork it, deploy it, sell whatever you want through it.

## Get Running in 2 Minutes

You need [Docker](https://www.docker.com/products/docker-desktop/) installed. That's it.

```bash
git clone https://github.com/SatsRail/privapaid.git
cd privapaid
cp .env.docker.example .env
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). A setup wizard walks you through everything:

1. Name your instance and pick a theme color
2. Paste your SatsRail API key (from your [SatsRail merchant dashboard](https://satsrail.com))

Done. Log in with your SatsRail merchant credentials and start creating channels.

Encryption keys and auth secrets are generated automatically on first run.

## Deploy to the Cloud

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/53Raga?referralCode=6xvEI7&utm_medium=integration&utm_source=template&utm_campaign=generic)

One click spins up the app + Postgres from the template. Railway prompts for the required environment variables during deploy.

If you'd rather deploy your own fork manually:

1. **Create the project:** in [Railway](https://railway.com/), click **New Project** → **Deploy from GitHub repo** → pick your fork of `privapaid`. Railway will detect the `Dockerfile` and start a build.
2. **Add Postgres:** on the project canvas, click **+ Create** → **Database** → **Add PostgreSQL**.
3. **Generate secrets locally:**
   ```bash
   echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
   echo "SK_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   ```
4. **Set variables** on the `privapaid` service → **Variables** tab:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   NEXTAUTH_SECRET=<paste from step 3>
   SK_ENCRYPTION_KEY=<paste from step 3>
   SATSRAIL_API_URL=https://satsrail.com
   ```
   `${{Postgres.DATABASE_URL}}` is Railway's reference syntax — it auto-resolves to the connection string of the Postgres service. The Docker entrypoint runs `prisma migrate deploy` before starting the server.
5. **Deploy:** Railway redeploys automatically when variables change. Once the healthcheck on `/api/health` passes, open the public URL and complete the setup wizard.

> **Important:** always set `NEXTAUTH_SECRET` and `SK_ENCRYPTION_KEY` explicitly. Railway containers have ephemeral filesystems, so the entrypoint's auto-generated secrets would rotate on every restart — invalidating sessions and breaking decryption of existing content.

> **Set `CONTENT_KEK`** (32-byte base64, e.g. `openssl rand -base64 32`). Wraps the per-content DEK on `Media.blob.encryptedDek` so envelope-encrypted content (photos, articles) can be rotated without SatsRail's old key. Lose this and you can't re-encrypt envelopes. Previous versions used `PHOTO_KEK`; if you're upgrading, rename the variable (same value).

> **Slow-migration escape hatch:** if a migration ever times out against Railway's startup window and gets killed mid-run, `_prisma_migrations` will hold a row with `started_at` set but no `finished_at` — and every subsequent deploy will fail fast with a diagnostic. Repair by following the instructions in the entrypoint log (typically `DELETE FROM "_prisma_migrations" WHERE finished_at IS NULL;` on an empty schema, or `npx prisma migrate resolve --rolled-back <name>` otherwise). To skip auto-migration entirely and run `prisma migrate deploy` as a separate step instead, set `RUN_MIGRATIONS=false`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for EC2, Docker, and other deployment options.

## What You Get

- **Channels** — each creator gets their own page with a dedicated SatsRail product type for revenue grouping
- **Five media types** — see [Media Types](#media-types) below
- **Lightning payments** — customers pay with Bitcoin, funds go directly to your wallet
- **Encryption at rest** — all content encrypted with AES-256-GCM before it touches the database
- **Payment-gated access** — three-state gating (unavailable → locked → unlocked) with no unencrypted fallback
- **Macaroon-based persistent access** — signed tokens allow return visits without re-payment
- **Key rotation** — admin-controlled per-product key rotation with streaming re-encryption
- **White-label** — your name, your colors, your domain
- **RSS feeds** — per-channel `/c/{slug}/feed.xml` so viewers can follow new content in any RSS reader (auto-discovered via `<link rel="alternate">`)
- **Admin dashboard** — manage channels, media, and categories
- **NSFW toggle** — enable or disable adult content categories per instance

## Media Types

Every media item has a `media_type` that controls how content is stored, encrypted, and rendered. All five types share the same payment flow and per-product encryption — only the storage shape differs.

| Type | What `source_url` holds | Viewer renders | Notes |
|------|-------------------------|----------------|-------|
| `video` | Direct file URL (`.mp4`/`.webm`/HLS) or embed URL (YouTube, Vimeo, Twitch, Bunny Stream, Cloudflare Stream, Mux, Dailymotion) | `<video>` for direct files; `<iframe>` for known hosts | URL itself is encrypted; the host stores the bytes. |
| `audio` | Direct audio file URL (`.mp3`/`.wav`/`.flac`/`.aac`) | `<audio>` player with optional artwork from the thumbnail | URL itself is encrypted. |
| `article` | Markdown text *or* a URL | Markdown rendered inline (GFM, sanitized via DOMPurify in a closed shadow root); URLs render as an "Open article" external link card | Auto-detects URL vs markdown. Max 500KB. Links open in a new tab with `rel="noopener noreferrer"`. |
| `photo` | `EncryptedPhotoBlob.id` pointer to the encrypted bytes | `<img>` after client-side decryption | **Encrypted at rest in the `EncryptedPhotoBlob` Postgres table (bytea column).** Envelope encryption: a random per-photo DEK encrypts the bytes once; the DEK is encrypted under each product key. Upload through [`/api/admin/photos`](#) (multipart, 5MB cap, JPEG/PNG/WebP/GIF, EXIF stripped). Photos cannot be added via JSON import — bytes must be uploaded to encrypt. |
| `podcast` | Audio URL | Same as `audio` plus podcast-style metadata in JSON-LD | Treated like audio at render time. |

### How encryption maps to each type

- For `video`, `audio`, `article`, `podcast` the *URL or text* is encrypted into `MediaProduct.encrypted_source_url` (or `ChannelProduct.encrypted_media[].encrypted_source_url`) under the SatsRail product key. The viewer decrypts client-side after payment.
- For `photo`, the *bytes themselves* live encrypted in the `EncryptedPhotoBlob` table (Postgres `bytea`), and `MediaProduct.encryptedSourceUrl` holds the encrypted DEK (envelope). The viewer unwraps the DEK with the product key, fetches the ciphertext from `/api/photos/[id]`, and decrypts in the browser.

In every case the SatsRail Portal holds the encryption keys and never sees content; the Stream app holds the content (both an encrypted, buyer-facing copy and an admin-only plaintext copy for re-encryption — see Architecture below) and never persists product keys at rest.

## Content Import

Populate your instance from a JSON file — either the entire site (categories, channels, and media) or media for a single channel.

### Whole-Site Import

Upload a JSON file at **Admin > Import / Export** to create categories, channels, and media in one pass.

```json
{
  "version": "1.0",
  "categories": [
    { "slug": "bitcoin-education", "name": "Bitcoin Education", "position": 1 }
  ],
  "channels": [
    {
      "slug": "beginner",
      "name": "Level 1 — Beginner",
      "bio": "Start here.",
      "category_slug": "bitcoin-education",
      "nsfw": false,
      "product": {
        "name": "Full Channel Access",
        "price_cents": 500,
        "currency": "USD",
        "access_duration_seconds": 2592000
      },
      "media": [
        {
          "ref": 1,
          "name": "What is Bitcoin?",
          "source_url": "https://www.youtube.com/watch?v=example",
          "media_type": "video",
          "position": 1,
          "product": {
            "name": "What is Bitcoin? — Individual",
            "price_cents": 100,
            "currency": "USD",
            "access_duration_seconds": 604800
          }
        }
      ]
    }
  ]
}
```

### Channel Import

Add media to an existing channel at **Admin > Channels > [channel] > Import**. The file contains only a media array.

```json
{
  "version": "1.0",
  "media": [
    {
      "ref": 1,
      "name": "Episode Title",
      "source_url": "https://www.youtube.com/watch?v=example",
      "media_type": "video",
      "position": 1,
      "product": {
        "name": "Episode Title",
        "price_cents": 100,
        "currency": "USD",
        "access_duration_seconds": 604800
      }
    }
  ]
}
```

Importable `media_type` values: `video`, `audio`, `article`, `podcast`. The `photo` type is **not** importable via JSON — photo bytes must be uploaded through the admin UI (`/api/admin/photos`) so the `EncryptedPhotoBlob` row and DEK envelope can be created. See [Media Types](#media-types) for full details on each type.

Each media item can include a `product` with pricing — the import automatically creates the corresponding SatsRail product and encrypts the source URL. Imports are idempotent: re-importing with the same slugs or refs updates existing records.

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict mode) |
| Database | PostgreSQL + Prisma |
| Auth | NextAuth.js v5 (credentials) |
| Encryption | AES-256-GCM via Web Crypto API (browser) and Node.js crypto (server) |
| Payments | SatsRail (Bitcoin Lightning) |
| Styling | Tailwind CSS |
| Deployment | Docker |

## Architecture

### Encryption at Rest (and the plaintext recovery copy)

Every piece of content has an **encrypted buyer-facing copy** in Postgres:
`MediaProduct.encryptedSourceUrl` (and `ChannelProductMedia.encryptedSourceUrl`)
hold the AES-256-GCM ciphertext under the SatsRail product key, with the
product's UUID bound as AAD so a blob encrypted for product A is mathematically
useless in the context of product B. Photo bytes live encrypted in the
`EncryptedPhotoBlob` table (Postgres `bytea`) under a random per-photo DEK;
the DEK itself is what the product key wraps. A single media item can be sold
through multiple products (individually, as part of a bundle, etc.); each
product-media combination produces a separately encrypted blob locked with
that product's key.

The blob format is `Base64(IV[12] + ciphertext + auth_tag[16])`. The browser
splits the IV from the ciphertext+tag and decrypts using the Web Crypto API
after payment. The server plays no role in buyer-side decryption.

PrivaPaid also persists a **plaintext recovery copy** of each item on the
`Media` row — `Media.blob.url` for video/audio/podcast, and
`Media.blob.encryptedDek` (the per-content DEK wrapped under the operator's
`CONTENT_KEK`, decryptable server-side without SatsRail) for envelope-encrypted
media (photos, articles). This copy exists so admin-triggered key rotation can
re-encrypt every product blob in a single in-DB operation, without depending
on SatsRail still returning the old product key — that pipeline has failed in
practice and used to brick rotations mid-way through.

The cost of that choice is that a full Postgres dump now exposes the plaintext
URL for url-backed media (and the wrapped DEK for envelope-encrypted media,
which stays opaque unless `CONTENT_KEK` is also leaked). Mitigations:

- **No public route returns these fields.** The viewer page deliberately
  forwards only the `EncryptedEnvelope.id` pointer for envelope-encrypted
  media, and only the URL ciphertext for url-backed media. Regression test:
  `tests/integration/pages/viewer-photo-page.test.ts`.
- **Admin-only API surface.** Every endpoint that reads the plaintext fields
  lives under `/api/admin/*` and is gated by middleware + `requireOwnerApi()`
  defense-in-depth.
- **Sentry scrubber** redacts `source_url`, `encrypted_dek`, `password`,
  `satsrail_api_key`, `macaroon`, `authorization`, `cookie`, and `sk_*`/`pk_*`
  keys from every captured event so a mid-rotation error doesn't ship
  plaintext to the error tracker. See `src/lib/sentry-scrub.ts`.
- **`CONTENT_KEK` lives in env**, not the DB. Per-content DEKs stay opaque
  under a Postgres-only breach.

> **Migrating from `PHOTO_KEK`**: previous versions used a `PHOTO_KEK` env var
> for the same purpose. Rename `PHOTO_KEK=<value>` to `CONTENT_KEK=<value>` in
> your `.env` / secrets store before deploying — the value is unchanged, only
> the variable name. The old name is no longer read.

Full discussion lives in [docs/ENCRYPTION.md](docs/ENCRYPTION.md) § "Threat model".

### Content Gating

Content on a media page exists in one of three states:

| State | Condition | Behavior |
|-------|-----------|----------|
| **Unavailable** | No `MediaProduct` records exist (no encrypted blobs) | "Unavailable" overlay shown. Payment buttons disabled. No invoice is created. |
| **Locked** | Encrypted blobs exist but no valid access token | "Pay to Watch" overlay with pricing tiers. Lightning payment flow available. |
| **Unlocked** | Valid access token + successful decryption | Content plays. Blur removed. Source URL loaded from decrypted blob. |

The unavailable state prevents charging for content that can't be delivered — if there's no encrypted blob, there's no key to sell and no URL to decrypt. This short-circuits before any payment UI appears.

### Payment and Key Delivery

1. Buyer selects a product and pays a Lightning invoice
2. SatsRail confirms payment and issues a macaroon (signed access token) plus the product's decryption key
3. Key is delivered to the browser via HTTP polling through the stream app's own API routes
4. Browser decrypts the encrypted blob using Web Crypto API and loads the content
5. Macaroon is stored in an httpOnly cookie for return visits — it encodes `product_id` and an expiry, not the key itself

On return visits, the browser presents its macaroon to the stream app's `/api/macaroons` route, which proxies the verification request to SatsRail server-side. If the signature is valid and the token hasn't expired, the current product key is returned. No re-payment required. Macaroons survive key rotation because they reference `product_id`, not the key.

### Key Rotation

Products support admin-controlled key rotation with a two-key window:

1. Admin triggers rotation — current key moves to `old_key`, new key is generated
2. Product enters "rotation pending" state — media uploads are blocked, admin sees a badge
3. Admin triggers re-encryption — PrivaPaid decrypts each blob with `old_key` and re-encrypts with the new key, streaming progress
4. On success, `old_key` is cleared via the SatsRail API — rotation is complete

During the rotation window, existing buyers' macaroons remain valid but decryption will fail until re-encryption completes. This is pull-based by design — no webhooks are relied upon because they may not reach the destination.

### External References and SatsRail Blindness

PrivaPaid generates opaque `external_ref` values that SatsRail stores but never interprets. These refs encode scope and attribution using prefixes: `ch_` for channels, `md_` for individual media items. SatsRail uses them for revenue grouping and product lookup, but has zero knowledge of what they point to.

When a channel is created, PrivaPaid assigns an auto-incrementing numeric ref and creates a corresponding ProductType on SatsRail (`external_ref: ch_7`). When media is associated with a product, the product gets `external_ref: md_12`. This decouples payment identity from display identity — slugs are user-facing and editable, refs are stable and opaque.

Revenue attribution flows through these refs: channel earnings are grouped by ProductType, media earnings by `external_ref` within the type. No channel ID, media ID, or content type flag is needed on the order model.

## Development

```bash
npm install
cp .env.local.example .env.local   # Fill in your values
npm run dev                         # http://localhost:3001
```

Requires Node.js and PostgreSQL 16+ (`docker compose up -d postgres` or any managed Postgres).

## Commands

```bash
npm run dev                          # Dev server with hot reload
npm run build                        # Production build
npm run start                        # Start production server
npm run lint                         # ESLint
npx tsc --noEmit                     # Type-check
npm test                             # Full test suite
npm run test:decryption              # Decryption end-to-end specs only (fast)
npm run verify:sentry-dsn            # Confirm production build inlines NEXT_PUBLIC_SENTRY_DSN
npm run cleanup:orphan-photos        # Delete unreferenced encrypted-photo blobs
```

The decryption test suite is documented in [`tests/integration/decryption-e2e/README.md`](tests/integration/decryption-e2e/README.md) — read it before changing anything in `src/lib/content-encryption.ts`, `src/lib/client-crypto.ts`, or `src/components/PaymentWall.tsx`.

### Orphan photo cleanup

The photo upload flow writes an encrypted blob to the `EncryptedPhotoBlob` table *before* the admin commits to creating the Media row + first product. If the admin abandons the flow, the bytes sit forever — unrecoverable (DEK is gone) but consuming storage. Run the cleanup on a schedule to reclaim them.

```bash
# Defaults: 1-hour grace period, real deletes
npm run cleanup:orphan-photos

# Report only — no deletes
npm run cleanup:orphan-photos -- --dry-run

# Delete every unreferenced blob regardless of age (use with care)
npm run cleanup:orphan-photos -- --grace 0
```

Outputs a single JSON object summarising the run. Exits 0 on success, 2 if any individual delete failed.

**Scheduling:**
- **Railway / Render:** add a cron service (e.g. daily at 03:00 UTC) running `npm run cleanup:orphan-photos`.
- **systemd:** a simple `OnCalendar=daily` timer.
- **Kubernetes:** `CronJob` pointing at the same container image.
- **On-demand:** `POST /api/admin/photos/cleanup` (owner-only) accepts `{ graceSeconds?, dryRun? }` and returns the same stats — useful for ad-hoc cleanups from the admin dashboard.

## License

[FSL-1.1-ALv2](LICENSE) — Functional Source License, version 1.1, with Apache 2.0 as the future license.

You can use, copy, modify, and redistribute PrivaPaid for any purpose other than a **Competing Use** (offering it as a hosted product or service that substitutes for SatsRail's offering). Two years after each release, that release also becomes available under [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

See [LICENSE](LICENSE) for the full text. The FSL is a [fair-source](https://fair.io/) license originally written by Sentry — it lets you self-host, fork, deploy for clients, and build commercial businesses on top, while reserving the narrow case of building a competing platform.

