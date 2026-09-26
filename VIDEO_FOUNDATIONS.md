# Video pipeline foundations

Phase 1 supplies the opt-in processing foundation. Phase 2 now adds
[resumable encrypted ingestion](VIDEO_INGESTION.md) and native movie packaging.
Paid playback is Phase 3 in the [execution plan](ENCRYPTED_VIDEO_PLAN.md).
Existing protected MP4s continue using their existing encrypted format and player.

## Components and storage

- `VideoAsset` belongs to one existing video Media. Its published-version pointer
  is independent of the newest version. Failed replacements preserve publication.
- `VideoAssetVersion` stores immutable identity, encoding settings, wrapped root
  key, opaque object prefix, encrypted-manifest reference/digest, byte count,
  duration and progress. Phase 1 fixtures use format `0`; Phase 2 writes
  experimental PPV1 with a bounded encrypted descriptor and storage reservations.
- `VideoUploadSession` stores the authenticated merchant owner ID, byte counters,
  checksum, expiry and optional multipart provider reference. It never stores
  movie bytes. The owner ID is from the auth session, not the local Admin table.
- `VideoJob` is the durable PostgreSQL queue. There is no Redis dependency.
  `VideoWorker` contains bounded worker heartbeats, expired after one day.

No movie bytes or segment arrays go into these tables. Segment catalogs and
ciphertext belong in object storage. Asset listing uses a maximum 100-record
page and only returns the latest-version summary; wrapped keys are excluded.
Version and job history retention belongs to Phase 5. These foundations alone
establish no measured video-count or concurrent-viewer capacity.

The schema bounds sources to 10 GiB and retained output reservations to 100 GiB.
The Phase 2 handler imposes tighter per-attempt bounds and validates complete
encrypted output. The old protected MP4 upload limit remains 512 MiB.

## State and recovery

```text
uploading -> queued -> processing -> ready -> explicit publication
                 ^        |
                 +--------+ retry with backoff, maximum 3 attempts
                          +-> failed
uploading/queued/processing/failed -> cancelled
any retained version -> deleting -> deleted after verified cleanup (Phase 5)
```

Only a complete, owned, unexpired upload can queue a package job. Claims use
PostgreSQL row locks with `SKIP LOCKED`. Every attempt receives a random lease
fence and its own output prefix. The default lease is 60 seconds, heartbeating
at one-third of that interval. After a crash, another worker can reclaim an
expired job. Backoff is exponential, bounded at 300 seconds; exhausted jobs and
their versions fail. Lease comparisons use database time. All new timestamp
columns use `TIMESTAMPTZ(3)` to work with a non-UTC database server.

A worker must retain its unexpired lease to record readiness. Completion checks
the lease again inside the metadata transaction; failure rolls everything back.
Immutable object writes and separate attempt prefixes prevent a stale worker
from changing a winning worker's output. Publication accepts only the newest
ready generation with a completed job. A composite foreign key prevents the
published pointer from referencing a different asset. Deletion fences jobs and
clears publication before cleanup; Phase 5 implements actual orphan/object cleanup.

The worker claims `storage_probe` and scoped `package_asset` jobs. Its probe
encrypts a random 1 KiB sample, writes/reads/decrypts it, checks equality and deletes
it. The Phase 2 package handler verifies objects, complete timelines and the
product/key chain, then commits ready metadata and publication atomically.
Older format-0 state primitives remain internal test foundations only.

## Local setup

Use the same environment for the web app and worker:

```dotenv
VIDEO_PIPELINE_ENABLED=true
VIDEO_STORAGE_PROVIDER=local
VIDEO_LOCAL_ROOT=/absolute/private/persistent/video-pipeline
VIDEO_JOB_LEASE_SECONDS=60
```

Both need `DATABASE_URL` and the same `CONTENT_KEK`. For an existing installation,
use its existing KEK; generating a replacement makes existing content unreadable.
A fresh installation may generate a 32-byte base64 key with `openssl rand -base64 32`.
Keep it in runtime secrets/environment, backed up separately from the database.
The worker never generates a secret automatically.

```sh
npm ci
npm run db:deploy
npm run build:video-worker
npm run video-worker
```

For an interactive local run, export the environment first. Unlike Next.js,
the standalone worker does not load `.env.local` automatically. Do not put secrets
in command arguments. Start the web application separately as usual.

Local storage uses hashed object directories and private multipart staging.
Complete objects appear atomically; writes refuse to overwrite existing objects.
Range reads reject invalid boundaries, and object paths reject traversal/URLs.
Multipart transfer parts are bounded at 64 MiB; non-final parts must be at least
5 MiB. Completion streams one part at a time. Transport part sizes do not control
playback segment duration or SatsRail calls.

The local adapter is for development and small deployments. Its filesystem list
operation scans directory names and returns bounded pages; use S3 for large
catalogs. Local web/worker replicas must share the same persistent filesystem.
The local disk and database need backups together with the KEK. Phase 2 cleans
retained sources, losing attempts and interrupted atomic writes; see its
[retention policy](VIDEO_INGESTION.md). Native multipart consumers must abort
abandoned transfers. Arbitrary orphan and paid-version cleanup remains Phase 5.

## Docker

Use `.env.docker.example` as a template. Set the same explicit `CONTENT_KEK` in
`.env` for app and worker. On existing Docker installations, preserve the
app's persisted key when doing this. The example now reflects PostgreSQL, which
is the database in the supplied Compose configuration.

```sh
docker compose --profile video up -d --build
```

The worker is a separate image/process, runs as UID 1001, has a read-only root
filesystem, a 64 MiB temporary filesystem, no added Linux capabilities, a
128-process limit, 2 GiB memory limit with no additional swap and two CPUs. Persistent local storage is
on the shared `/app/data` volume. It waits for the app's health check; app startup
applies migrations. Runtime credentials are not build arguments or image layers.
Phase 2 includes FFmpeg and its bounded processing handler; core dumps are disabled.

Turning `VIDEO_PIPELINE_ENABLED=false` and stopping the worker returns the web app
to the existing behavior. The additive tables can remain. Do not drop them as a
rollback once they contain real data. No existing media are migrated automatically.

## Owner API and readiness

All three endpoints require an authenticated owner session:

| Endpoint | Result |
|---|---|
| `GET /api/admin/video-pipeline` | Setup status, storage provider, live worker count, latest probe status |
| `POST /api/admin/video-pipeline` | Queue an encrypted storage probe; no body; HTTP 202 with job ID |
| `GET /api/admin/video-pipeline/assets?limit=25&cursor=…` | Bounded asset summary page with next cursor |

POST requires an explicit `Origin` matching `AUTH_URL` or `NEXTAUTH_URL` (falling
back to request origin). Configure the canonical external URL behind a proxy.
Requests coalesce to one job per store per minute across web replicas. No request
accepts a bucket, URL, file path, object key or cloud credential from a browser.

For example, from an authenticated owner's browser console on the site:

```js
await fetch('/api/admin/video-pipeline', { method: 'POST' }).then(r => r.json());
await fetch('/api/admin/video-pipeline').then(r => r.json());
```

Readiness requires valid config, migrated tables, reachable storage, a worker
heartbeat within 30 seconds and a successful probe within one hour. Worker and
probe scopes hash the provider location and KEK fingerprint, so the wrong bucket
or a different worker key cannot satisfy readiness. The response never returns
that key, its fingerprint, the bucket or its paths. Re-run the probe after setup
changes or when readiness says `VIDEO_STORAGE_PROBE_REQUIRED`.

Useful codes: `VIDEO_DISABLED`, `VIDEO_CONTENT_KEK_REQUIRED`,
`VIDEO_S3_BUCKET_AND_REGION_REQUIRED`, `VIDEO_STORAGE_UNAVAILABLE`,
`VIDEO_DATABASE_MIGRATION_REQUIRED`, `VIDEO_WORKER_MISSING`,
`VIDEO_STORAGE_PROBE_REQUIRED`, `VIDEO_FOUNDATIONS_READY`.
A ready foundation is not an assertion that encoding, paid CDN playback or scale
qualification has shipped. The existing `/api/health` is unaffected by this flag.

## S3 and compatible storage

```dotenv
VIDEO_STORAGE_PROVIDER=s3
VIDEO_S3_BUCKET=your-private-bucket
VIDEO_S3_REGION=us-east-1
VIDEO_S3_PREFIX=privapaid-video/
# Optional for another S3-compatible service:
# VIDEO_S3_ENDPOINT=https://provider.example
# VIDEO_S3_PATH_STYLE=true
```

The pinned AWS SDK uses its standard credential chain; prefer a workload IAM
role. The [scoped worker policy example](examples/video/s3-worker-policy.json)
limits object operations to the configured prefix. Replace its bucket and prefix
before use. Keep S3 Block Public Access enabled. Bucket lifecycle rules should
abort abandoned multipart uploads; explicit deletion/orphan retention is Phase 5.
If bucket encryption uses a customer-managed KMS key, configure its necessary
permissions separately. No bucket or policy is provisioned automatically.

The adapter implements put, head, range read, paginated list, delete, multipart
begin/part/complete/abort. Put and multipart completion use `If-None-Match: *`;
a compatible provider must preserve these atomic conditions. Multipart ETags are
opaque transport identifiers, not the format's authenticated content digests.
The application encrypts before calling storage; cloud server-side encryption
alone does not provide the intended client-decrypted video format.

`DeliveryGrantIssuer` is a separate interface for Phase 3. It has no implementation
yet. Storage credentials never become buyer grants. SatsRail macaroons still
prove access and require the existing stateful verification/key-delivery API;
they do not decrypt chunks. Phase 1 requires no SatsRail API changes.

## Verification

Point both `DATABASE_URL` and `TEST_DATABASE_URL` at a **disposable** PostgreSQL
16 database. Tests truncate its application tables. The new suite applies real
migrations so that raw SQL CHECK constraints and composite foreign keys are tested.
Do not point it at a development database whose data must be retained.

```sh
npm run test:video-foundations
npm run typecheck
npm run lint
docker compose --env-file .env.docker.example -f docker-compose.yml --profile video config --quiet
docker build -f Dockerfile.video-worker -t privapaid-video-worker:test .
```

The S3 contract suite uses the real SDK against a local HTTP protocol double,
including its streaming checksum framing. It is not a live AWS/CloudFront test.
See [Phase 1 evidence](plans/video/evidence/phase-1.md) for measured results and
remaining release qualifications.

Protocol references: [PostgreSQL locking and SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html),
[S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[S3 multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html).
