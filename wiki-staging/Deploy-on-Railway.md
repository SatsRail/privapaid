# Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/53Raga?referralCode=6xvEI7&utm_medium=integration&utm_source=template&utm_campaign=generic)

One click spins up the app + Postgres from the template. Railway auto-generates `NEXTAUTH_SECRET`, `SK_ENCRYPTION_KEY`, and `CONTENT_KEK` at template-deploy time using `${{secret(32, ...)}}` — operators don't need to run `openssl` locally.

## Manual setup (your own fork)

1. **Create the project:** in [Railway](https://railway.com/), click **New Project** → **Deploy from GitHub repo** → pick your fork. Railway detects the `Dockerfile` and starts a build.
2. **Add Postgres:** on the project canvas, **+ Create** → **Database** → **Add PostgreSQL**.
3. **Generate secrets locally:**
   ```bash
   echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
   echo "SK_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   echo "CONTENT_KEK=$(openssl rand -base64 32)"
   ```
4. **Set service variables** on the privapaid service → **Variables** tab:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   NEXTAUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   NEXTAUTH_SECRET=<from step 3>
   SK_ENCRYPTION_KEY=<from step 3>
   CONTENT_KEK=<from step 3>
   SATSRAIL_API_URL=https://satsrail.com
   ```
   `${{Postgres.DATABASE_URL}}` is Railway's reference syntax — it auto-resolves to the connection string of the Postgres service.
5. **Deploy:** Railway redeploys on variable changes. Once the healthcheck on `/api/health` passes, open the public URL and complete the setup wizard.

## Required environment variables

| Variable | Purpose | Lose it → |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Container can't reach DB → won't boot |
| `NEXTAUTH_URL` | Your public URL (e.g. `https://stream-prod-xxxx.up.railway.app`) | Admin sign-in redirects break |
| `NEXTAUTH_SECRET` | 32-byte base64 secret for JWT signing | All admin sessions invalidated; users re-log in |
| `SK_ENCRYPTION_KEY` | 32-byte hex key that encrypts the SatsRail merchant API key in Postgres | **CATASTROPHIC** — can't talk to SatsRail. Restore from `.generated-env` or rotate the merchant API key. |
| `CONTENT_KEK` | 32-byte base64 KEK that wraps the per-content DEK for photos & articles | **CATASTROPHIC** — can't rotate product keys, can't admin-preview envelope content. Restore from backup. |
| `SATSRAIL_API_URL` | `https://satsrail.com` for production, `https://satsrail.com/api/v1` for the API base | Setup wizard can't reach SatsRail |

## Important callouts

### Ephemeral filesystem on Railway

Railway containers have ephemeral filesystems. The Docker entrypoint refuses to auto-generate `NEXTAUTH_SECRET`, `SK_ENCRYPTION_KEY`, or `CONTENT_KEK` onto ephemeral storage — losing those on restart would silently rotate the keys and brick every encrypted record in Postgres. **Set all three explicitly in Variables** before the container can boot.

### Slow-migration escape hatch

If a migration ever times out against Railway's startup window and gets killed mid-run, `_prisma_migrations` will hold a row with `started_at` set but no `finished_at`. Every subsequent deploy will fail fast with a diagnostic in the entrypoint log instead of looping the healthcheck silently. Repair via the steps in [[Stuck Migrations]].

To skip auto-migration entirely and run `prisma migrate deploy` as a separate step instead (recommended for very slow first-time migrations), set `RUN_MIGRATIONS=false` and run migrations from a one-shot Railway job before deploying the app.

### Migrating from `PHOTO_KEK`

Pre-2026-05 versions used `PHOTO_KEK`. Rename to `CONTENT_KEK` in your service Variables — same value, no rotation needed. The old name is no longer read.

## Cost

Railway Hobby plan is $5/month plus usage. A typical PrivaPaid instance (app + Postgres) runs $5–15/month total.

## Custom domain

Service Settings → **Networking** → **Custom Domain**. Railway provisions SSL automatically. Update `NEXTAUTH_URL` to the new domain after the cert is issued.

## See also

- [[Operator Playbook]] — env var reference and key backup procedures
- [[Stuck Migrations]] — repair workflow if you ever hit the stuck-migration case
- [[Healthcheck Failures]] — diagnosing `/api/health` failures
