# Phase 4 local implementation evidence

Date: 2026-09-26. Implementation is opt-in and **disabled by default**. This
record does not close the physical-device, full-film, live-CDN, security or scale
release gates. See [the plan](../../../ENCRYPTED_VIDEO_PLAN.md) and
[adaptive runbook](../../../VIDEO_ADAPTIVE.md).

## Implemented and verified locally

- Up to three no-upscale qualities, 360p/480p/720p fitting the source aspect ratio.
  One normalized 30 fps frame timeline, aligned keyframes, one shared audio track.
  Both 4- and 10-second presets pass real FFmpeg manifest and packet validation;
  fixtures include missing video/audio intervals and a movie without audio.
- Full encrypted source upload → private bridge → native encode → authenticated
  object/timeline verification → atomic publication for both presets. Three video
  init objects plus one audio init object are persisted as PPV1. A replacement
  receives a fresh key/prefix and leaves the previous descriptor/manifest intact.
  Queued legacy profiles remain single-quality.
- Bounded bridge backpressure: eight active requests, sixteen waiting slots,
  completion in queue order, cancellation on abort/disconnect. Tests deliberately
  stall storage and send twelve PUTs, verifying eight active writes; aborting the
  bridge does not start queued writes. Partial inventories prevent publication.
- Owner capacity API, deleted-media filtering, bounded catalog/search, authorization,
  no-store responses and omission of keys/provider paths. Creator tests cover
  upload resumption/retry, preset estimates, capacity and page navigation. Viewer
  tests cover the labelled quality selector, teardown and unsupported capabilities
  before a player or key request is created.
- Existing paid session, expiry, crypto, storage, upload and protected-video
  regression coverage remains passing. No SatsRail code changes in this phase.

## Chrome playback

The opt-in test runs the actual Shaka/Web Crypto player over two local HTTPS
sibling hostnames, real scoped delivery cookies and PPV1 ciphertext. The paid
session is a contract fixture; this is not a real Lightning purchase. The
4-second preset uses an 80-second multi-quality fixture; the 10-second preset
uses 120 seconds so both buffered quality transitions finish before the end.
Each also uses a 40-second silent fixture.

[4-second report](phase-4-chrome-4s.json) and
[10-second report](phase-4-chrome-10s.json) record Chrome 153.0.8010.53. Manual
switches preserve the buffer and play in one video element. The continuity
intervals had zero waiting events and zero sampled all-black frames. Tests also
seek repeatedly, pause/resume, lower the media server transfer rate from 2 MiB/s
to 160 KiB/s, and restore it. Automatic selection drops from 720p to 480p and
recovers; decoded video dimensions are checked at both transitions. Payment
cookies never reach the media host. These synthetic results do not establish
perceptual audio quality, long-film RAM use or behavior on an arbitrary network.

```sh
VIDEO_ADAPTIVE_TEST=true \
VIDEO_ADAPTIVE_REPORT=plans/video/evidence/phase-4-chrome \
npx vitest run tests/integration/video/browser-adaptive.test.ts
```

## Constrained container and crash recovery

[Container report](phase-4-container.json): actual non-root UID 1001, read-only
root, two CPUs, 2 GiB memory/swap limit, 128-process cap, no core dumps, dropped
capabilities and 64 MiB tmpfs. Node 22 Alpine / FFmpeg 8.1.2 worker image
`privapaid-video-worker:phase4-test`. Peak whole-container cgroup memory was
358,567,936 bytes (about 342 MiB), including native child processes. This is a
21-second 1280×720 synthetic source inside a 64 MiB MP4 upload, not a long-film
memory measurement or another 10 GiB test.

The upload resumes after server/client restart, a host encoder is killed after
its first persisted segment, and the constrained container recovers under a new
lease/attempt. It publishes all 30 output objects across three video qualities
and one audio track. The previous attempt cannot publish. Three interrupted
atomic-write directories remained unpublished and encrypted; age-based cleanup
removed them after simulated retention. The test's generated MP4 bytes now span
upload parts correctly when the synthetic source exceeds 8 MiB.

Use an explicitly disposable database; these tests truncate it. For example:

```sh
export DATABASE_URL='postgresql://video_test@127.0.0.1:55439/privapaid_video_test?schema=public'
export TEST_DATABASE_URL="$DATABASE_URL"
docker build -f Dockerfile.video-worker -t privapaid-video-worker:phase4-test .
VIDEO_LARGE_TEST=true VIDEO_LARGE_TEST_BYTES=67108864 \
VIDEO_ADAPTIVE_CONTAINER=true VIDEO_DOCKER_TEST=true \
VIDEO_DOCKER_IMAGE=privapaid-video-worker:phase4-test \
VIDEO_CONTAINER_REPORT=plans/video/evidence/phase-4-container.json \
npx vitest run tests/integration/video/large-ingestion.test.ts
```

The container needs access to that disposable database and local SatsRail
contract fixture through `host.docker.internal`, as in the Phase 2 harness.

## Regression run

Final run: **109 tests passed** across 18 files; the three opt-in browser/large
fixture files were skipped in that run and executed separately as described
above. The adaptive Chrome matrix adds two tests and constrained recovery adds
one test.

```sh
npx vitest run tests/unit/video tests/integration/video \
  tests/integration/api/protected-video.test.ts \
  tests/unit/lib/protected-video.test.ts \
  tests/unit/components/ProtectedVideoPlayer.test.tsx \
  tests/unit/components/ProtectedVideoUpload.test.tsx
```

## Build and remaining gates

TypeScript, scoped ESLint, whitespace validation and the production webpack build
pass. Both video flags were explicitly false during the build. Existing Next.js
middleware/Sentry/OpenTelemetry warnings remain unrelated to Phase 4.

The exposed presets are locally tested experimental presets. Production still
requires the same physical Safari/iOS/Android/Firefox matrix for each, two-hour
memory/seek/continuity measurement, perceptual audio/click and drift checks,
a full movie through a real paid CloudFront/S3 deployment, lifecycle/recovery
qualification, security review and the planned concurrent-viewer tests. No
production enablement, deployment, DRM guarantee or viewer-capacity claim is made.
