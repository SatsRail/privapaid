# PrivaPaid

[![Tests](https://github.com/SatsRail/privapaid/actions/workflows/test.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/test.yml)
[![CodeQL](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/SatsRail/privapaid/branch/main/graph/badge.svg)](https://codecov.io/gh/SatsRail/privapaid)

Source-available, encryption-first content platform powered by [SatsRail](https://www.satsrail.com/) Bitcoin Lightning payments. Sell any type of media — video, audio, articles, photos, podcasts — with instant, non-custodial payments. No payment processor accounts, no chargebacks, no middlemen.

Every piece of content is encrypted at rest — there is no unencrypted copy stored anywhere — and decryption happens entirely in the buyer's browser after payment — the server never decrypts content for a buyer. SatsRail manages encryption keys and payment verification but never sees your content. PrivaPaid never touches customer funds.

Fork it, deploy it, sell whatever you want through it.

## Get Running in 2 Minutes

You need [Docker](https://www.docker.com/products/docker-desktop/) installed. That's it.

```bash
git clone https://github.com/SatsRail/privapaid.git
cd privapaid
cp .env.docker.example .env
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). A setup wizard walks you through everything: name your instance, pick a theme color, paste your SatsRail merchant API key.

Encryption keys and auth secrets are generated automatically on first run and persisted to the local Docker volume.

## Deploy to the Cloud

### Railway (one click)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/privapaid?referralCode=6xvEI7&utm_medium=integration&utm_source=template&utm_campaign=generic)

The template spins up the app + Postgres and auto-generates all required secrets (`NEXTAUTH_SECRET`, `SK_ENCRYPTION_KEY`, `CONTENT_KEK`) via Railway's `${{secret(...)}}` syntax. Once the healthcheck on `/api/health` passes, open the public URL and complete the setup wizard.

Prefer your own fork, or want the variable reference, custom domain steps, and troubleshooting? See the **[Deploy on Railway walkthrough](https://github.com/SatsRail/privapaid/wiki/Deploy-on-Railway)**.

### Other platforms

- **[Deploy on EC2](https://github.com/SatsRail/privapaid/wiki/Deploy-on-EC2)** — `t3.small` + Docker Compose + Nginx + Let's Encrypt, ~$15/month
- **[Deploy on Elastic Beanstalk](https://github.com/SatsRail/privapaid/wiki/Deploy-on-Elastic-Beanstalk)** — for teams already on AWS EB
- **[Postgres: managed vs local](https://github.com/SatsRail/privapaid/wiki/Postgres:-managed-vs-local)** — when to use RDS, Supabase, Neon

## What You Get

- **Channels** — each creator gets their own page with a dedicated SatsRail product type for revenue grouping
- **Five media types** — video, audio, articles, photos, podcasts (see [Media Types](#media-types) below)
- **Lightning payments** — customers pay with Bitcoin, funds go directly to your wallet
- **Encryption at rest** — all content encrypted with AES-256-GCM before it touches the database
- **Payment-gated access** — three-state gating (unavailable → locked → unlocked) with no unencrypted fallback
- **Macaroon-based persistent access** — signed tokens allow return visits without re-payment
- **Key rotation** — admin-controlled per-product key rotation with streaming re-encryption
- **White-label** — your name, your colors, your domain
- **RSS feeds** — per-channel `/c/{slug}/feed.xml`, auto-discovered via `<link rel="alternate">`
- **Admin dashboard** — manage channels, media, and categories
- **NSFW toggle** — enable or disable adult content categories per instance

## Media Types

Every media item has a `media_type` that controls how content is stored, encrypted, and rendered. All five types share the same payment flow and per-product encryption — only the storage shape differs.

| Type | What `source_url` holds | Viewer renders | Encryption |
|------|-------------------------|----------------|------------|
| `video` | Direct file URL or embed (YouTube, Vimeo, Twitch, Bunny, Cloudflare Stream, Mux, Dailymotion) | `<video>` or `<iframe>` | Envelope: source-URL ciphertext in `MediaEnvelope`; DEK wrapped under `CONTENT_KEK` and per-product |
| `audio` | Direct audio URL | `<audio>` player with optional thumbnail artwork | Envelope: source-URL ciphertext in `MediaEnvelope`; DEK wrapped under `CONTENT_KEK` and per-product |
| `article` | Markdown text | Rendered GFM in a closed shadow DOM (sanitized via DOMPurify); URLs render as an external link card | Envelope: markdown ciphertext in `MediaEnvelope`; DEK wrapped under `CONTENT_KEK` and per-product |
| `photo` | `MediaEnvelope.id` | `<img>` after client-side decryption | Envelope: image ciphertext in `MediaEnvelope`; DEK wrapped under `CONTENT_KEK` and per-product |
| `podcast` | Audio URL | Same as audio plus podcast-style JSON-LD metadata | Envelope: source-URL ciphertext in `MediaEnvelope`; DEK wrapped under `CONTENT_KEK` and per-product |

Every media kind uses the same envelope encryption — url-backed (video/audio/podcast), article, and photo alike. The content payload (the source URL or the file bytes) is AES-256-GCM ciphertext in `MediaEnvelope.bytes`, and the operator-held `CONTENT_KEK` wraps each per-media DEK, so the operator can rotate product keys and admin-preview content without depending on SatsRail. There is no plaintext content at rest — a full Postgres dump reveals no source URL, no article body, and no photo bytes.

Full architecture and threat model: **[docs/ENCRYPTION.md](docs/ENCRYPTION.md)**.

## Content Import

JSON-based import for whole-site bootstrapping and per-channel additions. Re-importing the same `ref` updates instead of duplicating.

Format reference and examples: **[wiki / Content Import](https://github.com/SatsRail/privapaid/wiki/Content-Import)**.

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

The short version: every piece of content is encrypted once into a single `MediaEnvelope` per media — the source URL for link media, the file bytes for photos and articles — under a per-media DEK (AES-256-GCM). The DEK is persisted only wrapped: under `CONTENT_KEK` for operator-side recovery, and under each SatsRail product key (AES-256-GCM with the product UUID as AAD, so a wrapped key for product A is mathematically useless in the context of product B) for buyer delivery. Nothing content-related is stored in plaintext at rest.

Decryption happens entirely client-side after payment — the server never decrypts for a buyer.

Full discussion of the encryption design, threat model, and rotation mechanics: **[docs/ENCRYPTION.md](docs/ENCRYPTION.md)**.

## Development

### Checkout rendering

The checkout QR and invoice status load independently. `CheckoutOverlay` keeps
the invoice hidden behind “Preparing your invoice…” until the QR image loads
and the payment request, sats amount, and expiry arrive. Reveal them together:
adding payment controls after showing the QR shifts the centered dialog.

### JSON import safety

JSON imports support `video`, `audio`, `podcast`, and `article` (Markdown in
`source_url`). Upload encrypted photo files through the photo uploader; JSON
photo entries are rejected before the import starts. An import cannot overwrite
an existing photo by omitting or changing its media type. JSON exports contain
photo metadata only and are **not full backups**: preserve PostgreSQL data and
the instance encryption keys for disaster recovery.

Paid imports require a configured merchant API key. New or retried media imports
reconcile missing access links for existing channel passes; finish any pending
pass-key rotation before retrying. Imports can partially succeed when a remote
product call fails: inspect the error summary and retry the same file rather than
renaming entries. A lost progress connection is not confirmation of success.
Keep stable names/refs for idempotent retries. Lifetime duration accepts `0` or
legacy `null`; exports use `0`.

The sample photo galleries are Markdown articles referencing public example
images, not encrypted photo-file backups.

### Security dependency overrides

The lockfile pins patched framework and transitive dependencies. The scoped
`@prisma/config` → `deepmerge-ts` 8 override addresses GHSA-ggr8-5vv4-36mx while
retaining Prisma 6. It changes deep Map merging; this project has no custom
Prisma config or Map-based configuration. Recheck Prisma generate, schema push,
migration deployment, tests, and build when updating or removing this override.

```bash
npm install
cp .env.local.example .env.local   # Fill in your values, including CONTENT_KEK
npm run dev                         # http://localhost:3001
```

Requires Node.js 22+ and PostgreSQL 16+ (`docker compose up -d postgres` or any managed Postgres).

## Commands

```bash
npm run dev                          # Dev server with hot reload
npm run build                        # Production build
npm run start                        # Start production server
npm run lint                         # ESLint
npx tsc --noEmit                     # Type-check
npm test                             # Full test suite
npm run test:decryption              # Decryption end-to-end specs only (fast)
npm run cleanup:orphan-envelopes     # Delete unreferenced encrypted-content blobs
```

Operational guides for the production lifecycle live in the wiki:

- **[Operator Playbook](https://github.com/SatsRail/privapaid/wiki/Operator-Playbook)** — env vars, key backups, monitoring
- **[Orphan Cleanup](https://github.com/SatsRail/privapaid/wiki/Orphan-Cleanup)** — cron setup
- **[Backups and Restore](https://github.com/SatsRail/privapaid/wiki/Backups-and-Restore)**
- **[Upgrading](https://github.com/SatsRail/privapaid/wiki/Upgrading)**
- **[Stuck Migrations](https://github.com/SatsRail/privapaid/wiki/Stuck-Migrations)**, **[Missing CONTENT_KEK](https://github.com/SatsRail/privapaid/wiki/Missing-CONTENT_KEK)**, **[Healthcheck Failures](https://github.com/SatsRail/privapaid/wiki/Healthcheck-Failures)**

The decryption test suite is documented in [`tests/integration/decryption-e2e/README.md`](tests/integration/decryption-e2e/README.md) — read it before changing anything in `src/lib/content-encryption.ts`, `src/lib/client-crypto.ts`, or `src/components/PaymentWall.tsx`.

## License

[FSL-1.1-ALv2](LICENSE) — Functional Source License, version 1.1, with Apache 2.0 as the future license.

You can use, copy, modify, and redistribute PrivaPaid for any purpose other than a **Competing Use** (offering it as a hosted product or service that substitutes for SatsRail's offering). Two years after each release, that release also becomes available under [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

See [LICENSE](LICENSE) for the full text. The FSL is a [fair-source](https://fair.io/) license originally written by Sentry — it lets you self-host, fork, deploy for clients, and build commercial businesses on top, while reserving the narrow case of building a competing platform.

## Protected MP4 uploads

The new [encrypted video ingestion pipeline](VIDEO_INGESTION.md) adds resumable
uploads up to 10 GiB, private local/S3 storage, and a separate FFmpeg worker that
produces authenticated 4- or 10-second segments. It is disabled by default and
experimental. See [setup](VIDEO_FOUNDATIONS.md) and [verification](plans/video/evidence/phase-2.md).
The [paid segmented player](VIDEO_PLAYBACK.md) adds short-lived delivery cookies,
browser decryption and renewal. Its local Chrome gate passed; live CDN, full-film,
device and capacity gates remain open. `VIDEO_PLAYBACK_ENABLED=false` keeps it off.
[Adaptive quality and creator controls](VIDEO_ADAPTIVE.md) add up to three
resolutions, Auto/manual switching, upload estimates and a paginated video library.


Future large-scale encrypted segment delivery has an
[execution plan](ENCRYPTED_VIDEO_PLAN.md) with eight ordered phases, task
checklists, SatsRail dependencies and release gates. Phase 0 now has a standalone
[local format/player proof](tools/video-proof/README.md) and
[test evidence](plans/video/evidence/phase-0.md). Production integration remains
planned; the instructions below describe the current protected MP4 feature.

External video links become visible after purchase. For playback that requires
valid paid access on every request, owners can instead use **Upload protected
video** in the video media form. Existing external embeds remain unchanged.

Set `PRIVATE_VIDEO_DIR` to an absolute private, persistent directory writable by
the app (Docker Compose: `/app/data/private-videos` on the existing data volume).
Keep `CONTENT_KEK` configured and backed up separately. Upload a browser-compatible
H.264 MP4 with optional AAC audio, up to 512 MB. Wait for upload and validation,
then save and associate a paid product. FFprobe must be installed (included in
the Docker image); uploaded videos remain encrypted on disk during validation.
No database migration is required. Owner preview uses a separate authenticated
endpoint. Leave `PRIVATE_VIDEO_DIR` unset to disable uploads.

Configure your proxy to permit 512 MB uploads, preserve cookies/Range headers,
and disable upload buffering for `/api/admin/videos` and caching/response
buffering for `/api/media/*/video`. Next middleware excludes the upload route to
avoid buffering its body; the route independently enforces owner authentication,
same-origin requests, rate limiting, and size/type validation.

Video chunks are AES-256-GCM encrypted on disk. The browser receives an opaque
reference, not a public origin URL or the video storage key. After verifying the
buyer's macaroon, PrivaPaid decrypts chunks transiently to serve MP4 byte ranges.
This optional mode extends the original browser-only decryption architecture;
SatsRail still receives no video content or storage references.

Back up the private directory, database, and KEK. JSON exports carry references
only; moving protected videos requires the storage backup too. Abandoned uploads
and deleted/replaced media retain encrypted files; garbage collection is manual.
Replicas need shared storage. No transcoding or HLS/DASH is provided.

A copied playback address alone grants no access. Paid viewers can still save
video bytes or share their bearer cookie. Expiry stops further streaming; it
cannot revoke already buffered or downloaded bytes.

Protected playback safeguards: uploads show byte progress and can be cancelled.
Two uploads and 16 playback requests may run concurrently per process; change the
latter with `PRIVATE_VIDEO_MAX_STREAMS` (1–128). Stalled streams close after one
minute. `PRIVATE_VIDEO_MIN_FREE_MB` preserves 1024 MiB of free filesystem space
by default (minimum 128). Configure proxy-level limits for multiple replicas.
`FFPROBE_PATH` can select a custom validator binary. Failed/unsupported videos
are removed before publication. Orphan cleanup and disk alerts remain operator
responsibilities.

Checkout confirms that the exact purchase cookie was accepted. If saving fails,
keep the page open and use **Retry saving access**; it reuses the completed
payment. No second invoice is created. Playback distinguishes expired/missing
access from temporary outages and offers a retry without another payment.
