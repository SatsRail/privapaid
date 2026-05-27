# Upgrading

Version bumps without breaking encryption or losing access to encrypted content.

## Pre-flight checks

Before every upgrade:

1. **Read [`CHANGELOG.md`](https://github.com/SatsRail/privapaid/blob/main/CHANGELOG.md)** for breaking changes
2. **Back up Postgres** ([[Backups and Restore]] § "Postgres backups")
3. **Confirm all three keys are backed up** off-platform (`SK_ENCRYPTION_KEY`, `CONTENT_KEK`, `NEXTAUTH_SECRET`)
4. **Test on staging if possible** — a `pg_dump`-restore-and-deploy cycle against a clone catches migration issues before they hit production

## Upgrade procedure

### Docker Compose (EC2, self-hosted)

```bash
cd /home/ec2-user/privapaid
git pull
docker compose build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The Docker entrypoint runs `prisma migrate deploy` automatically on boot. New migrations apply before the app accepts traffic. If anything fails, the entrypoint exits 1 with a diagnostic — see [[Stuck Migrations]].

If you're pulling a published image instead of building:

```bash
docker pull ghcr.io/satsrail/privapaid:latest
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Railway

Push to the `main` branch (or your deploy branch) and Railway auto-builds and redeploys. The entrypoint applies migrations. Watch the Deploy Logs for the migration output.

### Elastic Beanstalk

```bash
eb deploy
```

Same flow: entrypoint runs on container start, migrations apply, app serves.

## Encryption considerations

PrivaPaid's encryption keys are persistent identifiers. **Never rotate them as part of a routine upgrade** — that's a separate, manual operation with its own procedure (see "Key rotation" below).

Specifically:

- `SK_ENCRYPTION_KEY` must remain the same across upgrades. Rotating it breaks decryption of the stored merchant API key in `Settings.satsrailApiKeyEncrypted`.
- `CONTENT_KEK` must remain the same. Rotating it breaks admin preview and key rotation for envelope-encrypted content.
- `NEXTAUTH_SECRET` can rotate (logs out all admins, no data loss).

The entrypoint guards against accidental rotation by refusing to auto-generate any of these if `/app/data/.generated-env` is on ephemeral storage. As long as you set them explicitly in env (Railway, EB) or persist `/app/data` on a volume (EC2), they stay stable.

## Schema migrations

Every upgrade may include new Prisma migrations under `prisma/migrations/`. The entrypoint applies them in order via `prisma migrate deploy`. Behavior:

- **Forward migrations only** — no automatic downgrades. Roll back via Postgres restore if a migration is wrong.
- **Idempotent on no-op** — running `migrate deploy` against an up-to-date DB exits 0 with "Database schema is up to date".
- **Atomic per migration** — each migration's transaction either commits fully or rolls back. Partial application requires a `SIGKILL` mid-transaction (see [[Stuck Migrations]]).
- **Long migrations** — if a migration takes longer than your platform's startup timeout, the container can be killed mid-run. Use `RUN_MIGRATIONS=false` and run `npx prisma migrate deploy` as a separate one-shot job for those upgrades.

## Key rotation (separate from upgrades)

Key rotation is admin-triggered from the Stream UI, NOT triggered by upgrading. The flow:

1. Admin clicks "Rotate Key" on a product in the admin dashboard
2. SatsRail mints a new product key, moves the old key to `old_key`
3. PrivaPaid re-encrypts every blob covering that product, streaming progress to the admin
4. On success, `old_key` clears on SatsRail's side

Existing buyers' macaroons survive rotation because they reference `product_id`, not the key. Decryption fails between step 2 and step 3 completion — keep the window short. See [[Key Rotation Errors]] for what to do if step 3 errors out.

## Rolling back

There's no automatic rollback. To revert:

1. **Pin the previous image version** (or `git checkout` the previous commit and rebuild)
2. **Restore the pre-upgrade Postgres dump** ([[Backups and Restore]] § "Restore Postgres")
3. **Keep the same keys** — never rotate during a rollback

If a migration was the issue, the restored DB won't have the new migration's row in `_prisma_migrations`, so the older code won't see schema drift. Boot proceeds normally.

## Major-version upgrade checklist

For breaking-change releases (announced in `CHANGELOG.md`):

- [ ] Read the CHANGELOG entry end-to-end
- [ ] Back up Postgres + all three keys
- [ ] Test on a staging environment with production-clone data
- [ ] Schedule a maintenance window (typically 15–30 minutes for a 10–100k row instance)
- [ ] Deploy
- [ ] Verify `/api/health` → 200
- [ ] Verify an existing paid viewer can still decrypt their content
- [ ] Verify admin preview on an envelope-encrypted article (proves `CONTENT_KEK` still works)

## See also

- [[Backups and Restore]] — pre-upgrade backup procedure
- [[Stuck Migrations]] — recovery if a migration fails mid-deploy
- [[Key Rotation Errors]] — separate procedure for rotating product keys
