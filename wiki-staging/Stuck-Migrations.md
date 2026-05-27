# Stuck Migrations

The most common reason a PrivaPaid deploy fails fast at startup. Symptoms:

```
FATAL: Database has migrations in a failed or stuck state.
       prisma migrate deploy will not proceed.
```

The entrypoint prints this and exits 1, so the container never serves a healthcheck. This is **intentional** — the alternative was silently looping the healthcheck for the deploy window's full duration (Railway's is 5 minutes), making it look like a "network problem" instead of a "schema problem".

## What causes it

`prisma migrate deploy` was killed mid-migration. Common triggers:

- **Platform killed the container** (Railway healthcheck timeout, ECS task definition kill, etc.) before the migration's transaction committed
- **OOM** during a large schema change on a tiny instance
- **Network blip** to Postgres mid-`ALTER TABLE`
- **You hit Ctrl-C** during a manual `prisma migrate deploy`

In any of those cases, the `_prisma_migrations` table holds a row with `started_at` set but `finished_at = NULL` and `rolled_back_at = NULL`. Prisma refuses to start a new migration until that row is resolved.

## Diagnose

Connect to your Postgres and run:

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at,
       substring(logs, 1, 2000) AS log_excerpt
FROM "_prisma_migrations"
ORDER BY started_at;
```

Look for rows where `finished_at` is `NULL` and `rolled_back_at` is `NULL`. Those are the stuck ones.

## Repair

### Case 1: empty database (no app tables exist yet)

This happens on first-ever deploys that got killed before completing the init migration. Simplest fix:

```sql
DELETE FROM "_prisma_migrations";
```

Then redeploy. The entrypoint runs `prisma migrate deploy` which applies every migration from scratch against the empty schema.

### Case 2: migration applied schema changes but didn't finalize the marker

The schema is partially in the new state. You need to either roll back manually or accept the partial change.

**Option A — roll back the partial change in SQL, then mark the migration as rolled-back:**

```bash
# Connect to the DB and reverse whatever the migration did:
psql $DATABASE_URL
> DROP TABLE "NewTableMigrationCreated";   # or whatever
> \q

# Tell Prisma the migration was rolled back so it retries on next deploy:
DATABASE_URL=... npx prisma migrate resolve --rolled-back <migration_name>
```

**Option B — finish the migration manually, then mark it applied:**

```bash
# Connect to the DB and finish whatever the migration left undone:
psql $DATABASE_URL
> ALTER TABLE ... ;          # whatever the migration would have done
> \q

# Tell Prisma the migration is complete:
DATABASE_URL=... npx prisma migrate resolve --applied <migration_name>
```

### Case 3: the migration's transaction succeeded but Prisma's marker update failed

Rare. The schema is in the new state but `_prisma_migrations` doesn't reflect it. Same fix as Option B above (`--applied`).

## Prevent recurrence

- **Move migrations out of the entrypoint** for platforms with strict startup timeouts. Set `RUN_MIGRATIONS=false` and run `npx prisma migrate deploy` as a one-shot job before the app deploys.
- **Right-size the instance** for the schema change. Indexes on multi-million-row tables can take minutes; a `t3.nano` will OOM.
- **Test migrations on a production-clone DB** before deploying. A `pg_dump`-restore-and-run-migrate cycle in CI catches most issues.

## See also

- [[Deploy on Railway]] — `RUN_MIGRATIONS=false` escape hatch documentation
- [[Operator Playbook]] — backup procedure (do this before any migration that touches existing data)
