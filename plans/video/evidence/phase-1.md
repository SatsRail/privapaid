# Phase 1 evidence — asset, storage and worker foundations

Date: 2026-09-26. Branch: `feature/video-foundations`. Work is uncommitted locally;
no commit hash, PR, deployment or live cloud resource is claimed. This branch
also carries the preceding Phase 0 work. Unrelated SatsRail-client header changes
already present in the worktree were preserved.

The owner requested Phase 1 before the outstanding Phase 0 device/full-playback
gates closed. The new feature is disabled by default and keeps format version 0
experimental. Production format qualification remains a prerequisite for release.

## Implemented

- Additive migration `20260926140000_video_foundations`: assets, immutable-version
  metadata, owned upload sessions, durable jobs and worker heartbeats. It stores
  wrapped content keys/references only, with CHECK bounds and a composite
  publication foreign key. Existing media rows and content formats are untouched.
- Postgres queue with `FOR UPDATE SKIP LOCKED`, database-time leases, random
  per-attempt fences/prefixes, heartbeat, bounded retry/backoff and bounded
  expired-job recovery. Readiness and publication are separate; replacements
  cannot destroy the current published pointer merely by failing.
- Private local and S3 storage adapters: immutable writes, range/head/list,
  multipart start/part/complete/abort/delete. Separate delivery-grant interface;
  no grant issuer, viewer route, CDN or per-segment SatsRail call.
- A compiled standalone worker with an encrypted storage self-test, safe failure
  codes, resource-limited Docker image/Compose profile and runtime secrets.
  It does not claim movie packaging jobs until Phase 2 supplies that handler.
- Owner-only readiness/probe and paginated catalog APIs, strict POST Origin,
  cross-replica probe coalescing, default-off flag, scoped IAM example, and
  [operator instructions](../../../VIDEO_FOUNDATIONS.md).

## Verification

Environment: macOS arm64, Node 25.8.1 locally, npm 11.11.0, PostgreSQL 16 in a
separate temporary cluster, Prisma 6.19.3, Next.js 16.3.5, Vitest 4.1.11,
AWS SDK S3 3.1141.0 and esbuild 0.28.2. The database used port 55439 and only
synthetic test data. Its default timezone was America/Los_Angeles.

| Check | Result |
|---|---|
| Full migration chain applied to an empty disposable PostgreSQL database | Pass, 11 migrations |
| `npm run test:video-foundations` | 26 tests passed across three files |
| Existing protected-video/payment/key/decryption regressions, flag off | 176 tests passed across 15 files |
| `npm run typecheck` | Pass |
| `npm run lint` | Zero errors; four existing Next navigation warnings |
| `npm run build:video-worker` | Pass |
| `npm run build -- --webpack`, flag off with test configuration | Pass, including new owner routes |
| Compose config with `video` profile | Pass |
| Docker worker build and constrained container smoke | Pass, Node 22.23.3 / Linux arm64, UID 1001 |

The final worker image was built from the current sources and started with a
read-only root, 64 MiB `/tmp`, a private temporary data mount, all capabilities
dropped, no-new-privileges, one CPU, 512 MiB RAM and a 64-process limit. It
connected to the disposable database, completed an encrypted probe on its first
attempt, and passed both Docker's health check and an explicit healthcheck command.
A normal SIGTERM shutdown exited with code 0, and the temporary container was
removed. No cloud account or real content was used.

The foundation tests cover actual database constraints, missing/incomplete or
wrong-owner uploads, duplicate job coalescing, two simultaneous claimants,
heartbeats, stale completion/publication, failure backoff and exhaustion,
cancellation, deletion/publication races, failed replacements and older versions
finishing after newer ones. The crash test kills an owned child process with
SIGKILL after its database claim, then checks reclaim and rejection of the stale
lease. A separate test invokes the compiled worker against real local storage
and checks that its encrypted probe completes and cleans up its object.

Storage contracts cover both the real filesystem and the real AWS SDK against a
local HTTP S3 protocol double, including default streaming checksum framing:
byte round trips, ranges, metadata, pagination, concurrent immutable writers,
multipart completion/conflict/abort, malformed paths/ranges and local partial
writes/symlinks. AWS credentials in that harness are dummy values.

The existing regression selection was:

```sh
npx vitest run \
  tests/unit/lib/protected-video.test.ts \
  tests/unit/lib/protected-video-probe.test.ts \
  tests/unit/lib/access-gate.test.ts \
  tests/unit/lib/content-dek.test.ts \
  tests/unit/lib/satsrail.test.ts \
  tests/integration/api/protected-video.test.ts \
  tests/integration/api/media-unlock.test.ts \
  tests/integration/decryption-e2e \
  tests/unit/components/ProtectedVideoUpload.test.tsx
```

Both `DATABASE_URL` and `TEST_DATABASE_URL` pointed at the same disposable database;
`VIDEO_PIPELINE_ENABLED=false` for that regression command. The foundation suite
controls its own flag. Tests truncate application tables and must never be run
against retained data.

## Findings resolved during verification

- Non-UTC PostgreSQL exposed a timestamp-without-timezone bug that delayed claims.
  New tables now use `TIMESTAMPTZ(3)` and all lease comparisons use database time.
- Completion rechecks the fence/expiry inside the same transaction as version
  readiness. Publication locks the asset before checking the current version to
  avoid republishing a version that concurrent deletion just withdrew.
- Probes and heartbeats are scoped to the storage location and KEK fingerprint.
  Changing a bucket/root or providing a different key cannot reuse prior readiness.
- Recovery batches are bounded to 100 exhausted jobs per claim, with skipped locked
  rows. Readiness checks table availability without scanning the full job count.
- Compose requires matching `pids_limit` and deployment process limits; both are 64.
- The initial Docker build stalled in the desktop credential helper. An isolated
  temporary Docker configuration allowed anonymous access to the public Node image
  without changing the user's Docker authentication configuration.

The production web build reports existing Sentry/middleware deprecations and an
optional OpenTelemetry Winston transport warning. It completed successfully.

## Limits and next work

This evidence does not establish live AWS/provider interoperability, IAM deployment,
CDN authorization, browser movie decryption, 10 GiB upload support or concurrent
viewer capacity. No SatsRail API changes or cloud provisioning were performed.
The filesystem adapter scans directory names; use the S3 adapter for large object
catalogs after qualifying the chosen provider. Orphan cleanup, job retention,
backup/restore automation and final deletion are Phase 5 work.

Next: V2.1 resumable encrypted upload APIs, product/key prerequisites, rotation
coordination and quotas. Phase 2 must authenticate and validate all output before
using the ready/publication primitives. Close Phase 0 physical-device, continuous
long-playback and profiling gates before freezing the production format.
