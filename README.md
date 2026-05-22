# PrivaPaid Stream

[![Tests](https://github.com/SatsRail/privapaid_app/actions/workflows/test.yml/badge.svg)](https://github.com/SatsRail/privapaid_app/actions/workflows/test.yml)
[![CodeQL](https://github.com/SatsRail/privapaid_app/actions/workflows/codeql.yml/badge.svg)](https://github.com/SatsRail/privapaid_app/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/SatsRail/privapaid_app/branch/main/graph/badge.svg)](https://codecov.io/gh/SatsRail/privapaid_app)

Open-source, encryption-first content platform powered by [SatsRail](https://www.satsrail.com/) Bitcoin Lightning payments. Sell any type of media — video, audio, articles, photos, podcasts — with instant, non-custodial payments. No payment processor accounts, no chargebacks, no middlemen.

All content is encrypted at rest. The server never stores plaintext, never decrypts content, and never touches customer funds. Decryption happens entirely in the buyer's browser after payment. SatsRail manages encryption keys and payment verification but never sees your content.

Fork it, deploy it, sell whatever you want through it.

## Get Running in 2 Minutes

You need [Docker](https://www.docker.com/products/docker-desktop/) installed. That's it.

```bash
git clone https://github.com/SatsRail/privapaid_app.git
cd privapaid_app
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

1. **Create the project:** in [Railway](https://railway.com/), click **New Project** → **Deploy from GitHub repo** → pick your fork of `privapaid_app`. Railway will detect the `Dockerfile` and start a build.
2. **Add MongoDB:** on the project canvas, click **+ Create** → **Database** → **Add MongoDB**.
3. **Generate secrets locally:**
   ```bash
   echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
   echo "SK_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   ```
4. **Set variables** on the `privapaid_app` service → **Variables** tab:
   ```
   MONGODB_URI=${{MongoDB.MONGO_URL}}
   NEXTAUTH_SECRET=<paste from step 3>
   SK_ENCRYPTION_KEY=<paste from step 3>
   SATSRAIL_API_URL=https://satsrail.com
   ```
   `${{MongoDB.MONGO_URL}}` is Railway's reference syntax — it auto-resolves to the connection string of the MongoDB service.
5. **Deploy:** Railway redeploys automatically when variables change. Once the healthcheck on `/api/health` passes, open the public URL and complete the setup wizard.

> **Important:** always set `NEXTAUTH_SECRET` and `SK_ENCRYPTION_KEY` explicitly. Railway containers have ephemeral filesystems, so the entrypoint's auto-generated secrets would rotate on every restart — invalidating sessions and breaking decryption of existing content.

See [DEPLOYMENT.md](DEPLOYMENT.md) for EC2, Docker, and other deployment options.

## What You Get

- **Channels** — each creator gets their own page with a dedicated SatsRail product type for revenue grouping
- **Five media types** — see [Media Types](#media-types) below
- **Lightning payments** — customers pay with Bitcoin, funds go directly to your wallet
- **Encryption at rest** — all content encrypted with AES-256-GCM before it touches the database
- **Payment-gated access** — three-state gating (unavailable → locked → unlocked) with no unencrypted fallback
- **Macaroon-based persistent access** — signed tokens allow return visits without re-payment
- **Key rotation** — admin-controlled per-product key rotation with streaming re-encryption
- **Payment-gated comments and flags** — only paying customers can interact
- **White-label** — your name, your colors, your domain
- **Pseudonymous customers** — sign up with a nickname, no email required
- **Admin dashboard** — manage channels, media, and categories
- **NSFW toggle** — enable or disable adult content categories per instance

## Media Types

Every media item has a `media_type` that controls how content is stored, encrypted, and rendered. All five types share the same payment flow and per-product encryption — only the storage shape differs.

| Type | What `source_url` holds | Viewer renders | Notes |
|------|-------------------------|----------------|-------|
| `video` | Direct file URL (`.mp4`/`.webm`/HLS) or embed URL (YouTube, Vimeo, Twitch, Bunny Stream, Cloudflare Stream, Mux, Dailymotion) | `<video>` for direct files; `<iframe>` for known hosts | URL itself is encrypted; the host stores the bytes. |
| `audio` | Direct audio file URL (`.mp3`/`.wav`/`.flac`/`.aac`) | `<audio>` player with optional artwork from the thumbnail | URL itself is encrypted. |
| `article` | Markdown text *or* a URL | Markdown rendered inline (GFM, sanitized via DOMPurify in a closed shadow root); URLs render as an "Open article" external link card | Auto-detects URL vs markdown. Max 500KB. Links open in a new tab with `rel="noopener noreferrer"`. |
| `photo` | GridFS pointer to the encrypted bytes | `<img>` after client-side decryption | **Encrypted at rest in our own GridFS.** Envelope encryption: a random per-photo DEK encrypts the bytes once; the DEK is encrypted under each product key. Upload through [`/api/admin/photos`](#) (multipart, 5MB cap, JPEG/PNG/WebP/GIF, EXIF stripped). Photos cannot be added via JSON import — bytes must be uploaded to encrypt. |
| `podcast` | Audio URL | Same as `audio` plus podcast-style metadata in JSON-LD | Treated like audio at render time. |

### How encryption maps to each type

- For `video`, `audio`, `article`, `podcast` the *URL or text* is encrypted into `MediaProduct.encrypted_source_url` (or `ChannelProduct.encrypted_media[].encrypted_source_url`) under the SatsRail product key. The viewer decrypts client-side after payment.
- For `photo`, the *bytes themselves* live encrypted in GridFS, and `MediaProduct.encrypted_source_url` holds the encrypted DEK (envelope). The viewer unwraps the DEK with the product key, fetches the ciphertext from `/api/photos/[id]`, and decrypts in the browser.

In every case the SatsRail Portal holds the encryption keys and never sees content; the Stream app holds the content and never sees plaintext keys at rest.

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

Importable `media_type` values: `video`, `audio`, `article`, `podcast`. The `photo` type is **not** importable via JSON — photo bytes must be uploaded through the admin UI (`/api/admin/photos`) so the encrypted GridFS file and DEK envelope can be created. See [Media Types](#media-types) for full details on each type.

Each media item can include a `product` with pricing — the import automatically creates the corresponding SatsRail product and encrypts the source URL. Imports are idempotent: re-importing with the same slugs or refs updates existing records.

## Stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict mode) |
| Database | MongoDB + Mongoose |
| Auth | NextAuth.js v5 (credentials) |
| Encryption | AES-256-GCM via Web Crypto API (browser) and Node.js crypto (server) |
| Payments | SatsRail (Bitcoin Lightning) |
| Styling | Tailwind CSS |
| Deployment | Docker |

## Architecture

### Encryption at Rest

Every piece of content in PrivaPaid is encrypted before it touches the database. There is no unencrypted storage path — this is enforced, not optional.

Each product in SatsRail carries a 32-byte AES-256-GCM encryption key. When an admin associates media with a product, the source URL is encrypted with that product's key and stored as a `MediaProduct` record in MongoDB. No plaintext source URL is ever persisted in the database. The URL exists in server memory only for the instant it takes to encrypt (at upload time and during key rotation re-encryption), then is discarded.

A single media item can be sold through multiple products (individually, as part of a bundle, etc.). Each product-media combination produces a separately encrypted blob locked with that product's key. Media cannot be uploaded until a product exists and its encryption key is available — the upload gate enforces this.

The blob format is `Base64(IV[12] + ciphertext + auth_tag[16])`. The browser splits the IV from the ciphertext+tag and decrypts using the Web Crypto API. The server plays no role in decryption.

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

Requires Node.js and MongoDB (local or Atlas).

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

The photo upload flow writes an encrypted blob to GridFS *before* the admin commits to creating the Media row + first product. If the admin abandons the flow, the bytes sit forever — unrecoverable (DEK is gone) but consuming storage. Run the cleanup on a schedule to reclaim them.

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

[MIT](LICENSE)

