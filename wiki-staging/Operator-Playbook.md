# Operator Playbook

Everything an operator needs to keep a PrivaPaid instance running safely.

## The three keys you can't lose

| Key | Format | What it protects | Recovery if lost |
|---|---|---|---|
| `SK_ENCRYPTION_KEY` | 32 bytes hex (64 chars) | The SatsRail merchant API key stored in `Settings.satsrailApiKeyEncrypted` | Rotate your SatsRail merchant API key, re-run setup wizard |
| `CONTENT_KEK` | 32 bytes base64 (44 chars incl `=`) | The per-content DEK on `Media.blob.encryptedDek` for every photo and article | **No recovery.** You lose the ability to rotate product keys and admin-preview envelope content. Existing paid viewers retain access until their macaroon expires. New product creation over old content fails. |
| `NEXTAUTH_SECRET` | 32 bytes base64 | JWT signing for admin sessions | Annoying not catastrophic — all admins re-sign-in |

Back up **all three** to your password manager + a printed safe + your secrets manager (1Password, Bitwarden, AWS Secrets Manager, etc.). The `.generated-env` file in `/app/data/` on EC2 holds them if the entrypoint auto-generated; copy that file off the server.

## Where each key is generated and persisted

| Platform | Auto-generation | Persistence |
|---|---|---|
| **Railway** | Template uses `${{secret(32, "base64")}}` and `${{secret(32, "hex")}}` to mint them at deploy time | Stored as service variables |
| **EC2 / Docker compose** | Entrypoint generates if missing and the volume is non-ephemeral | `/app/data/.generated-env` (persistent volume) |
| **Ephemeral fs (no volume)** | Entrypoint **refuses** and exits 1 | Operator must set explicitly |

## Required environment variables

```
DATABASE_URL              postgresql://user:pass@host:port/db?schema=public
NEXTAUTH_URL              https://yourdomain.com
NEXTAUTH_SECRET           <base64-32>
SK_ENCRYPTION_KEY         <hex-32>
CONTENT_KEK               <base64-32>
SATSRAIL_API_URL          https://satsrail.com/api/v1
SATSRAIL_WEBHOOK_SECRET   <any unique string>
```

Optional:

```
RUN_MIGRATIONS=false        Skip auto-migration in the entrypoint. Use when migrations are run as a separate step.
OTEL_EXPORTER_OTLP_ENDPOINT Enable OpenTelemetry export.
NEXT_PUBLIC_SENTRY_DSN      Browser Sentry DSN (must be set at BUILD time, not just runtime).
```

## Backup procedure

### Daily

1. **Postgres dump** to encrypted storage (S3 with SSE-KMS, etc.). See [[Backups and Restore]].
2. **`.generated-env`** if you're on EC2 — copy off the server.

### Weekly

3. **Verify a restore** in a staging environment. `pg_restore` + boot a container with the same `CONTENT_KEK`, confirm admin preview works.

### Per-rotation

4. **Snapshot before key rotation.** A snapshot from immediately before rotation gives you a safe rollback if mid-rotation goes wrong.

## Health monitoring

`/api/health` returns:

```json
{ "status": "ok", "db": "connected", "satsrail": "reachable" }
```

Status codes: `200` when all checks pass, `503` when any of `db` or `satsrail` is degraded.

Wire it into your monitoring tool of choice (Better Uptime, Pingdom, Cronitor, etc.). See [[Healthcheck Failures]] for what each degraded state means.

## Routine maintenance

- **Orphan envelope cleanup**: schedule `npm run cleanup:orphan-envelopes` daily. See [[Orphan Cleanup]].
- **Postgres vacuum**: managed Postgres providers auto-vacuum. For self-hosted, the default autovacuum settings on Postgres 16 are fine for PrivaPaid's write load.
- **Log rotation**: container logs grow unbounded by default. Configure `docker-compose.yml` with `logging.options.max-size: 100m` and `max-file: 5`.
- **Sentry quota**: if you wired Sentry, set release-level error budget alerts. PrivaPaid surfaces decryption failures as Sentry events tagged `context: PaymentWall.decryptOnAccess`.

## See also

- [[Backups and Restore]]
- [[Upgrading]]
- [[Stuck Migrations]]
- [[Missing CONTENT_KEK]]
