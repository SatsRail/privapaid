# Postgres: Managed vs Local

The Docker Compose `postgres` service is fine for development and small self-hosted deployments. For production on shared infrastructure (EC2, EB, Railway, Kubernetes), a managed Postgres is the right default.

## Comparison

| | Managed (RDS / Supabase / Neon / Railway) | Local (Docker Compose) |
|---|---|---|
| **Setup** | Provision via provider console (~5 min) | Included in `docker-compose.yml` (zero-config) |
| **Backups** | Automatic, point-in-time recovery (PITR) | Manual — see [[Backups and Restore]] |
| **Scaling** | Click to scale up/down, read replicas | Limited to server resources |
| **High availability** | Multi-AZ failover available | Single instance |
| **Major version upgrades** | One-click | Manual `pg_upgrade` |
| **Cost** | Free tiers available; $5–25/month for prod | Free (uses server disk) |
| **Best for** | Production, EB, Railway, Kubernetes | Development, small self-hosted |

## Switching to managed Postgres

The Docker entrypoint's `prisma migrate deploy` runs on every boot regardless of which Postgres you point at. To switch:

1. **Provision** the managed instance (Postgres 16+; AES-256-GCM tests assume this version)
2. **Set `DATABASE_URL`** in `.env` (or the equivalent platform env var) to the provider's connection string. Include `sslmode=require` for any provider that supports it
3. **Remove the `postgres` service** from `docker-compose.yml` (or just stop starting it)
4. **Restart the container** — entrypoint auto-applies migrations

PrivaPaid expects:

- `citext` extension (for case-insensitive email + slug uniqueness)
- `bytea` column type (for `EncryptedEnvelope.bytes` and similar)
- `jsonb` column type (for `Media.blob` JSONB shape)

All are stock in any Postgres 16 install.

## Provider notes

### RDS / Aurora

- **Aurora Serverless v2** with `min_capacity = 0.5 ACU` runs at about $40/month minimum. Good fit for EB + multi-AZ requirements.
- **RDS db.t4g.micro** is the cheap option ($12–15/month). Single-AZ, manual backups, fine for small deployments.
- Configure security groups so the app's compute (EB env, ECS service) can reach Postgres on port 5432.

### Supabase

- Free tier covers 500MB + 2GB egress. Sufficient for a low-volume PrivaPaid instance.
- **Disable RLS** on PrivaPaid tables — the app does its own access gating via `requireOwnerApi()` middleware. RLS adds nothing here and complicates queries.

### Neon

- Branching feature is genuinely useful for testing migrations against production-clone data.
- Free tier covers 0.5GB storage + 100 hours compute/month.

### Railway

- Provisioned automatically when you click the [[Deploy on Railway]] template button.
- Backups via Railway's snapshot feature (paid plans only).
- `DATABASE_URL` auto-resolves via `${{Postgres.DATABASE_URL}}` reference syntax — no manual connection-string juggling.

## Connection pooling

Prisma uses a built-in connection pool. For most PrivaPaid workloads the default 20 connections per pool is plenty. Adjust via the URL:

```
postgresql://user:pass@host:5432/db?schema=public&connection_limit=10&pool_timeout=20
```

If you're running on a tiny Postgres instance (db.t4g.micro has `max_connections = 81`), drop `connection_limit` to 5–10 to leave headroom.

## See also

- [[Backups and Restore]] — provider-specific automated backups + KEK backup off-platform
- [[Operator Playbook]] — env var reference
