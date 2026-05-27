# Orphan Envelope Cleanup

The photo upload flow (and the article PATCH flow) writes encrypted bytes to the `EncryptedEnvelope` table *before* the admin commits to creating the Media row. If the admin abandons the flow, the bytes sit forever — unrecoverable (DEK is gone or replaced) but consuming storage. Run the cleanup on a schedule to reclaim them.

## Run manually

```bash
# Defaults: 1-hour grace period, real deletes
npm run cleanup:orphan-envelopes

# Report only — no deletes
npm run cleanup:orphan-envelopes -- --dry-run

# Delete every unreferenced row regardless of age (use with care)
npm run cleanup:orphan-envelopes -- --grace 0
```

Outputs a single JSON object summarising the run. Exits 0 on success, 2 if any individual delete failed.

## What gets deleted

Rows in `EncryptedEnvelope` that:

1. Are older than the grace period (default 1 hour)
2. Are NOT referenced by any `Media` row's `blob.envelopeId` for either `mediaType = "photo"` or `mediaType = "article"`

Article PATCH allocates a new envelope row each edit and orphans the old one — the cleanup script picks those up too.

## Why 1 hour by default

The admin upload flow is: POST to `/api/admin/photos` → server writes envelope row → returns id + DEK → client POSTs to `/api/admin/media` → server writes Media row pointing at the envelope. There's a window between those two requests where the envelope exists but no Media references it. An hour is comfortably longer than any realistic admin session.

Set `--grace 0` only if you're confident no admin is currently uploading.

## Scheduling

### Railway / Render

Add a cron service running `npm run cleanup:orphan-envelopes`. Daily at 03:00 UTC is reasonable.

### systemd

`/etc/systemd/system/privapaid-cleanup.service`:

```ini
[Service]
Type=oneshot
WorkingDirectory=/home/ec2-user/privapaid
ExecStart=/usr/bin/docker compose exec -T app npm run cleanup:orphan-envelopes
User=ec2-user
```

`/etc/systemd/system/privapaid-cleanup.timer`:

```ini
[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now privapaid-cleanup.timer
```

### Kubernetes

`CronJob` pointing at the same container image:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: privapaid-orphan-cleanup
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cleanup
              image: ghcr.io/satsrail/privapaid:latest
              command: ["npx", "tsx", "scripts/cleanup-orphan-envelopes.ts"]
              envFrom:
                - secretRef:
                    name: privapaid-env
          restartPolicy: OnFailure
```

## On-demand from admin dashboard

`POST /api/admin/photos/cleanup` (owner-only) accepts `{ graceSeconds?, dryRun? }` and returns the same stats. Useful for ad-hoc cleanups after a known-bad upload session.

## See also

- [Architecture (docs/ENCRYPTION.md)](https://github.com/SatsRail/privapaid/blob/main/docs/ENCRYPTION.md) — why upload writes envelope before Media
- [[Operator Playbook]] — recommended cron schedule
