# Phase 2 evidence — resumable encrypted ingestion

Date: 2026-09-26. Branch: `feature/video-ingestion`. Work is local and uncommitted;
no PR, deployment, real customer upload or live cloud account was used. The branch
preserves the preceding Phase 0/1 work and unrelated existing SatsRail-client header
changes. The feature stays off by default. Production playback/device/provider
and scale qualification are still required.

## Implemented contract

- Migration `20260926160000_video_ingestion` adds bounded upload bindings, leases,
  quota reservations, storage scope, cleanup state and an encrypted descriptor.
  Existing media and legacy protected-MP4 storage/player remain unchanged.
- Owner-only start/status/part/resume/complete/retry/abort APIs with exact Origin,
  4 KiB JSON and 8 MiB raw-part limits; SHA-256, immutable idempotent writes,
  database offsets and shared reservation/admission limits.
- Valid current product/key required before accepting content, local binding on
  every part, fresh remote checks at lifecycle boundaries, rotation-aware resume
  retaining the same media DEK. No video metadata is sent to SatsRail.
- Seekable loopback range input, bounded native FFmpeg processing and encrypted
  output, no plaintext application staging. PPV1 binds version, attempt and object.
- Full authenticated inventory and packet/keyframe timeline validation before a
  single transaction commits readiness, descriptor, job completion and publication.
- Creator file selection, saved-offset resume, upload/processing progress,
  pause/cancel, actionable errors and retained-source retry. Worker retention
  cleanup preserves the winning output and releases unused reservations.

See [runbook](../../../VIDEO_INGESTION.md) and [format](../../../VIDEO_FORMAT.md).

## Verification results

Local: macOS arm64, Node 25.8.1, PostgreSQL 16 (separate disposable database,
America/Los_Angeles server timezone), Prisma 6.19.3, Next 16.3.5, FFmpeg/FFprobe
8.1.2. Container: Node 22.23.3, Linux arm64, FFmpeg 8.1.2.

| Check | Result |
|---|---|
| Additive migration on the existing Phase 1 test schema | Pass, 12 migrations present |
| Video + existing protected playback/payment/checkout/crypto/middleware suites | 253 tests passed, opt-in large test skipped |
| Creator screen interaction tests | 3 passed: restored upload/resume, failed-job retry, cancel/product prerequisite |
| Final video-only regression run, including creator UI | 51 passed, opt-in large test skipped; 256 regular tests verified across the runs above |
| Full 10 GiB HTTP upload with server/client state restart | Pass |
| SIGKILL after encrypted encoder output, lease reclaim and fresh attempt | Pass; partial result never published |
| Actual S3 SDK movie packaging through local S3 protocol double | Pass; no live AWS qualification claimed |
| TypeScript / ESLint | Pass; full lint has four existing Next navigation warnings |
| Next production webpack build, feature off | Pass; existing Sentry/telemetry warnings remain |
| Final FFmpeg worker image build and constrained movie smoke | Pass |
| Compose opt-in profile with example environment | Pass |

The real 4-second and 10-second fixtures include video plus AAC. Additional tests
cover video-only output, malformed/truncated input, duration limits, wrong keys,
rotation and actual DEK rewrapping, owner isolation, checksums, oversized bodies,
offset conflicts, quotas, persistence-before-ack recovery and repeated completion.
Independent Web Crypto decrypts PPV1 object types. Wrong identity, swapped object,
wrong root, corrupted bytes/tag/header and truncation fail closed.

During real processing, cancellation, ciphertext tampering or product association
changes prevent publication and preserve a preceding ready version. The new
encrypted descriptor independently decrypts under the original media DEK, while
legacy `MediaEnvelope.bytes` remains byte-for-byte unchanged.

## 10 GiB restart and crash test

The fixture contains 8.5 seconds of synthetic video plus a valid large MP4 `free`
box, generated one part at a time in RAM. It writes **10,737,418,240 actual source
bytes** as **1,280 encrypted source objects** over real HTTP to actual route
handlers backed by PostgreSQL/local storage. The test-only server replaces auth
with a fixed synthetic owner; separate API tests cover owner and Origin rejection.

At 5 GiB, the test kills the server. A new server and reconstructed client state
query the saved offset, validate resume and send the remaining parts. This models
browser state loss; it is not a manual browser upload rehearsal. The creator
component and browser upload helper are separately tested for reload, file
reselection, saved-offset transfer, completion and cancellation behavior.

The first encoder is killed with SIGKILL immediately after it persists a media
object. No descriptor or published pointer exists. After lease expiry, a new
process authenticates the complete source, writes a different attempt namespace
and publishes a complete video. The inspection found 1,288 PPV1 ciphertext objects
(source, completed output and retained losing output), no remaining temporary or
multipart staging, and no raw product key in object metadata.

Measured on this machine, not a production SLA:

| Measurement | Result |
|---|---:|
| HTTP upload including restart | 59.158 s |
| Full test including two source scans/worker attempts/inspection/cleanup | 94.94 s |
| First server peak RSS | 252,768 KiB |
| Restarted server peak RSS | 255,936 KiB |
| Successful worker Node peak RSS | 222,864 KiB |
| Processing attempts | 2 |
| Existing SatsRail product/key requests for the complete workflow | 18 |

Node processes ran with a 256 MiB JavaScript heap cap; RSS includes additional
native/buffer memory. Worker Node RSS excludes the FFmpeg child. The fixture's
short low-resolution video does **not** measure real two-hour or 4K encoding time,
worst-case native codec memory, physical browser behavior or CDN viewer capacity.

## Linux container smoke

The final image processed the restart fixture with a 16 MiB padded source, using
the actual compiled worker CLI and live local PostgreSQL/test key endpoint. It ran
as UID 1001 with two CPUs, 2 GiB memory and equal memory+swap ceiling, 128 processes,
zero core-dump limit, read-only root, 64 MiB tmpfs, dropped capabilities and
no-new-privileges. The full cgroup (Node, FFmpeg and cache) peaked at **161,902,592
bytes**, approximately 154.4 MiB. The job completed on attempt two and the container
was removed. The temporary synthetic-ciphertext bind mount alone used relaxed
permissions to bridge macOS/container UIDs; deployed private volumes must retain
their normal service ownership/permissions.

The full-size and Linux runs exposed early-close errors from normal demuxer
seeks (`EPIPE` on macOS, `ECANCELED` on Linux). The bridge now tolerates these only
on source reads. Output errors, failed authentication and missing segments remain
fatal. The first encoding tests also exposed too-low bridge concurrency; the
bounded limit accommodates FFmpeg's independent audio/video HTTP writes.

## Reproduction

Use an explicit **disposable** PostgreSQL database: these suites truncate it.
Export identical `DATABASE_URL` and `TEST_DATABASE_URL`, then:

```sh
npm ci
npm run db:deploy
npm run test:video-foundations
VIDEO_LARGE_TEST=true npx vitest run tests/integration/video/large-ingestion.test.ts
```

The 10 GiB test requires at least 12 GiB free disk and removes only its own
temporary directory. `VIDEO_LARGE_TEST_BYTES=16777216` selects the smaller debug
fixture and must not be reported as a 10 GiB result. For the container check:

```sh
docker build -f Dockerfile.video-worker -t privapaid-video-worker:phase2-test .
VIDEO_DOCKER_TEST=true VIDEO_LARGE_TEST=true VIDEO_LARGE_TEST_BYTES=16777216 \
  npx vitest run tests/integration/video/large-ingestion.test.ts
```

Docker Desktop must resolve `host.docker.internal` to the disposable host database
and local test key endpoint. Linux CI can provide an equivalent host mapping.

Before production release: complete the outstanding Phase 0 device/full-playback
gates, implement Phase 3 buyer/session/CDN integration, test live private storage,
test the deployed proxy without plaintext spooling, benchmark representative
long/complex movies, and finish security/scale/lifecycle qualification.
