# PrivaPaid Stream

[![Tests](https://github.com/SatsRail/privapaid/actions/workflows/test.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/test.yml)
[![CodeQL](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml/badge.svg)](https://github.com/SatsRail/privapaid/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/SatsRail/privapaid/branch/main/graph/badge.svg)](https://codecov.io/gh/SatsRail/privapaid)

Source-available, encryption-first content platform powered by [SatsRail](https://www.satsrail.com/) Bitcoin Lightning payments. Sell any type of media — video, audio, articles, photos, podcasts — with instant, non-custodial payments. No payment processor accounts, no chargebacks, no middlemen.

The buyer-facing copy of every piece of content is encrypted at rest, and decryption happens entirely in the buyer's browser after payment — the server never decrypts content for a buyer. SatsRail manages encryption keys and payment verification but never sees your content. PrivaPaid never touches customer funds.

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
