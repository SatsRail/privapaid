# Encrypted video: execution plan

**Status:** Phases 1–2 implemented and verified locally. Phase 0 device/long-playback gates remain open.  
**Plan date:** 2026-09-25.  
**Next task:** V3.1 paid playback session contract; complete V0.2/V0.5 qualification before freezing the production format.  
**Scope:** ship the complete encrypted streaming implementation in PrivaPaid,
under its existing [license](LICENSE), with operator-owned storage and delivery.

This is the execution source of truth. Each phase has task IDs, dependencies,
deliverables and an exit gate. Check a task only after its evidence exists. Update
the tracker and execution record when work finishes or the design changes.
Implementation filenames below are proposed unless listed as existing code.

## Outcome and boundaries

A creator uploads a full-length movie, chooses a tested segment-duration preset,
and publishes it for paid viewing. Thousands of buyers receive the same encrypted
segments through a CDN and decrypt them in a continuously buffered player.
PrivaPaid performs encoding and encryption once per asset version/rendition,
independently of the number of buyers. SatsRail handles payment verification and
product-key delivery at session start and renewal, independently of segment size.

Everything specific to the media feature ships here: upload UI/API, processing
worker, format implementation, player integration, storage and delivery adapters,
edge authorization code where needed, deployment templates, tests and runbooks.
One versioned release can contain several independently scalable processes.
SatsRail and the operator's storage/CDN accounts remain external services.

### Working defaults

These defaults make the phases executable; Phase 0 records the tested selections.
They are design targets, not existing features or measured capacity.

| Area | Starting point |
|---|---|
| Protection | Browser decryption as a new, explicit delivery mode; retain existing server-decrypted protected MP4s |
| First production provider | S3 + CloudFront reference integration; compare R2 cost before provisioning, keep provider interfaces separate |
| Local development | Filesystem object adapter and development delivery endpoint; never present this as a production CDN |
| Output | On-demand fragmented MP4, H.264 with optional AAC; one rendition for the first paid playback milestone |
| Player | Evaluate a maintained player, starting with Shaka; pin the tested version and document any adapter |
| Creator controls | Start experiments at 4 and 10 seconds; expose only presets that pass continuity and memory tests |
| Ingestion | Resumable uploads beyond the current 512 MiB limit; initial test target 10 GiB and a two-hour movie |
| Audience | Desktop Chrome/Firefox/Safari/Edge, Android Chrome and iPhone/iPad Safari; record exact supported versions and devices |
| Scale qualification | 1,000 concurrent viewers preliminary test, then a 5,000-viewer release target and a 10,000-viewer stretch test with explicit resource/cost ceilings |
| Renewal | Candidate 5-minute maximum grant, renew early with jitter; finalize using expiry/revocation needs and measured quotas |

Browser decryption gives a paying viewer usable content keys and decoded bytes.
Expiry denies future authorized delivery; it cannot revoke retained keys, saved
video or already buffered bytes. Product-key rotation alone cannot revoke a
copied movie key. This mode does not promise DRM or protection from a paying
viewer recording a movie. If device-enforced DRM becomes a requirement, revise
this scope before committing to the format and player.

### Implementation languages

Recommended baseline, recorded 2026-09-26: retain the existing application stacks
and measure the processing path before adding a new language. PrivaPaid currently
uses TypeScript/Next.js; Ruby/Rails belongs to SatsRail. A Ruby worker could drive
the same native tools, but would add another runtime to PrivaPaid's distribution.

| Component | Baseline | Reason |
|---|---|---|
| PrivaPaid web, jobs and storage orchestration | TypeScript/Node.js; worker runs separately | Reuse current models, validation and deployment tooling |
| Transcoding and segmentation | FFmpeg process with bounded input/output | Reuse established native media processing |
| Worker encryption | Node's native crypto API initially | AES runs through native cryptographic libraries; avoid implementing it in application-language loops |
| Browser player and decryption | TypeScript/JavaScript + Web Crypto | Integrates with the browser's media and cryptography APIs |
| SatsRail verification/key API | Existing Ruby/Rails | Scale and profile the small authorization requests independently of video delivery |
| A measured CPU/memory bottleneck in custom worker code | Optional Rust executable/component | Prefer Rust's memory-safety guarantees for new native orchestration or buffer-handling code |

[FFmpeg](https://ffmpeg.org/about.html) provides encoding and container tools;
[Node crypto](https://nodejs.org/api/crypto.html) exposes OpenSSL-backed operations;
[Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) exposes
browser cryptographic primitives. Using TypeScript to orchestrate those operations
does not mean implementing video codecs or AES in JavaScript.

Rust and C++ are both viable for native components. Rust is the preferred option
if a new component is justified, for its [memory and thread safety](https://rust-lang.org/).
That does not make unsafe code, native dependencies or protocol design automatically
safe. Use maintained cryptographic libraries in every language. New C++ code needs
a concrete integration benefit that outweighs its memory-management burden.

In V0.5, record separate measurements for encoding, crypto, data copying, object
I/O and orchestration. Native crypto may still block a Node worker's event loop;
bound work and measure scheduling/backpressure before increasing concurrency.
In SR3, profile database/network waits separately from Ruby CPU time. A language
rewrite cannot fix a quota or database bottleneck. Add Rust only for an evidenced
need in throughput, memory, latency or a required native interface, retaining the
versioned file/job contracts and cross-runtime vectors. Package its source and
reproducible build in PrivaPaid if adopted. Browser Rust/Wasm is not required for
the initial player; evaluate it only for a measured gap in the native browser APIs.

### Invariants for every phase

- SatsRail receives no movie files, storage paths, manifests or segment metadata.
  Keep payment confirmation and key delivery as distinct API operations.
- A macaroon proves access and contains no movie key. Verify it through SatsRail's
  existing stateful API. Never export SatsRail signing secrets to PrivaPaid.
- Product keys remain in SatsRail; PrivaPaid persists only wrapped content keys.
  Buyer keys stay in volatile memory, outside URLs, browser storage and logs.
- Application encryption precedes durable storage. Cloud server-side encryption
  is additional protection, not a substitute for ciphertext delivered to browsers.
- Persistent staging, segment files and crash artifacts must not contain raw
  media. Worker plaintext is transient and bounded. Resolve FFmpeg seekable input
  and output without silently creating plaintext temporary files or swap copies.
- Each new asset version gets fresh key material. Specify nonce uniqueness,
  domain separation and authenticated asset/version/rendition/segment identity,
  including init segments and manifest integrity, before freezing the format.
- Bind the movie key to the existing product-to-media envelope chain. Preserve
  direct-sale and channel access; do not add a single shared movie key to Product.
- Published versions are immutable. A retry must never overwrite an object with
  changed plaintext under a reused key/nonce. Publication is an atomic pointer
  switch after the complete version validates.
- CDN authorization runs on cache hits as well as misses. Grants are limited to
  the authorized asset/version and end no later than paid entitlement or token
  expiry. Buyer credentials must not fragment the ciphertext cache unnecessarily.
- No new SatsRail call per media segment. Preserve existing access behavior for
  other media types and existing protected MP4s.

## Phase tracker and dependencies

| Phase | Status | Depends on | Deliverable / exit gate |
|---|---|---|---|
| 0 — Format and player proof | In progress; [local evidence](plans/video/evidence/phase-0.md) | None | Local Chrome/WebKit proof passes; physical-device and full-duration playback gates remain |
| 1 — Asset, storage and worker foundations | Complete; local gate passed | 0 draft contract; see sequencing decision below | [Runbook](VIDEO_FOUNDATIONS.md), [evidence](plans/video/evidence/phase-1.md) |
| 2 — Resumable encrypted ingestion | Complete; local gate passed, default off | 1 | [Runbook](VIDEO_INGESTION.md), [10 GiB restart/crash evidence](plans/video/evidence/phase-2.md); buyer integration remains Phase 3 |
| 3 — Paid CDN playback | Implemented locally; live/full-film gate open | 2; SR1 for real grants | A full-length movie plays through the real purchase/key flow and private CDN |
| 4 — Creator controls and adaptive playback | Not started | 3 | Tested duration presets and aligned quality changes preserve playback continuity |
| 5 — Lifecycle, recovery and migration | Not started | 3 | Rotation, restore, safe cleanup and legacy migration work without losing paid access |
| 6 — Security, devices and scale qualification | Not started | 4, 5; SR1–SR3 | Published test evidence meets the release criteria below |
| 7 — Operator packaging and staged release | Not started | 6 | A clean installation, upgrade, restore and rollback succeed from shipped instructions |

Sequencing decision, 2026-09-26: the owner explicitly requested Phase 1 while
Phase 0 physical-device/full-duration gates were still open. Proceed with these
independent, default-off foundations. Keep format `0` experimental; this does not
waive Phase 0, production playback, provider or scale qualification. The owner
subsequently requested Phase 2 under the same experimental/default-off boundary.
Phase 2 uses explicitly versioned PPV1; the PPV0 proof remains unchanged.

Implement in order; phase-sized changes can be split into smaller PRs. SatsRail
work can proceed once Phase 0 defines the authorization contract. Packaging starts
in Phase 1 and is completed in Phase 7. Additional providers follow the first
qualified release, rather than blocking the initial paid movie milestone.

## Existing code to build on

Inspect these files again when each phase begins; this plan is not a replacement
for the current source.

| Area | Existing entry points |
|---|---|
| Media, envelopes and product associations | [Prisma schema](prisma/schema.prisma), [media envelopes](src/lib/media-envelope.ts) |
| Encryption and recovery | [content encryption](src/lib/content-encryption.ts), [KEK wrapping](src/lib/content-dek.ts), [browser crypto](src/lib/client-crypto.ts) |
| Paid entitlement | [access gate](src/lib/access-gate.ts), [macaroon proxy](src/app/api/macaroons/route.ts), [checkout](src/app/api/checkout/route.ts) |
| Player and payment UI | [PaymentWall](src/components/PaymentWall.tsx), [ProtectedVideoPlayer](src/components/ProtectedVideoPlayer.tsx) |
| Current protected uploads | [upload route](src/app/api/admin/videos/route.ts), [store](src/lib/protected-video-store.ts), [probe](src/lib/protected-video-probe.ts) |
| Current protected playback | [video route](src/app/api/media/[id]/video/route.ts) |
| Key rotation | [product re-encryption](src/app/api/admin/products/[id]/re-encrypt/route.ts) |
| Deployment and commands | [Dockerfile](Dockerfile), [Compose](docker-compose.yml), [production overrides](docker-compose.prod.yml), [package scripts](package.json) |

Current protected MP4 storage uses encrypted 1 MiB byte chunks of an ordinary
file. Those are not independently playable fMP4 segments. Never reinterpret that
format as the new format or expose its storage key to buyers. Current upload and
playback limits remain documented in the [README](README.md#protected-mp4-uploads).

## Phase 0 — Prove the format and player

**Purpose:** resolve playback and cryptographic compatibility before building the
full ingestion and cloud stack. Branch suggestion: `feature/video-format-proof`.

- [x] **V0.1 — Reproducible fixture.** Generate an owned/synthetic H.264/AAC movie
  with frame/time markers, continuous audio and identifiable segment boundaries.
  Package init + fMP4 media segments at two candidate durations. Keep generated
  large fixtures outside Git; commit generators, checksums and exact tool versions.
- [ ] **V0.2 — Player experiment.** Pin a maintained player and integrate local
  authenticated decryption. Exercise playback, forward/backward seek, final short
  segment, pause/resume and bounded buffering on desktop and real iOS/Android.
  Shaka is a candidate, not evidence that native HLS supports our chosen format.
- [x] **V0.3 — Format specification (experimental draft).** Write `VIDEO_FORMAT.md` with the exact byte
  layout, authenticated manifest, version identifiers, key hierarchy, unique
  nonces, init handling and substitution defenses. Specify how a fresh movie key
  is wrapped through the existing media envelope and recovered by the operator.
  Compare the player's GCM layout/AAD behavior with these requirements; retain
  integrity through a reviewed adapter/design rather than dropping binding.
- [x] **V0.4 — Cross-runtime vectors.** Node encrypts and Web Crypto decrypts the
  same fixtures. Reject wrong keys, truncation, tag changes, swapped segments,
  rendition/index changes and manifest substitution before decode. Exercise
  interrupted encryption/retry to prove nonce safety.
- [ ] **V0.5 — Decision record.** Record the selected player/format, supported
  device floor, first provider, staging strategy, allowed input profile, initial
  presets and grant/renewal policy. Include measured startup, boundary behavior
  and peak memory, worker-stage CPU/I/O/copying measurements, unresolved blockers
  and dependency redistribution requirements. Confirm the language baseline above
  or document the evidence for introducing a native component.

**Exit gate:** proof runs from documented commands; a two-hour fixture plays with
no boundary-induced gaps or sync drift on the target devices, and tamper vectors
fail closed. If a required device cannot decrypt/play the format, resolve that
before Phase 1. A smaller support matrix must be explicitly recorded, not inferred
from a player library's generic support table.

**Evidence:** `VIDEO_FORMAT.md`, fixture generator, focused tests and
`plans/video/evidence/phase-0.md` containing browser/device/version results.

Implemented local proof: [run instructions](tools/video-proof/README.md),
[experimental format](VIDEO_FORMAT.md), [measured results](plans/video/evidence/phase-0.md).
Both segment presets have complete two-hour packet validation and 42-second
Chrome/WebKit playback tests. Long-fixture browser runs are sampled; physical
devices, perceptual audio and two-hour continuous playback remain unqualified.

## Phase 1 — Asset, storage and worker foundations

**Purpose:** make processing durable and independent of web requests.

- [x] **V1.1 — Versioned data model.** Add migrations for video asset versions,
  upload sessions and durable jobs, with media ownership, wrapped keys, provider
  references, format/encoding settings, checksums, byte counts and progress.
  Store media bytes and large segment catalogs in object storage; store only
  bounded metadata/references in Postgres. Add catalog pagination where needed.
- [x] **V1.2 — State machine.** Define `uploading → queued → processing → ready`,
  failure/cancellation and deletion states. Separate publication from readiness;
  a failed replacement keeps the previous version available. Use unique job keys,
  leases, fencing against stale workers, heartbeats, bounded retries and recovery.
- [x] **V1.3 — Provider boundaries.** Implement storage operations (put, multipart,
  read/head/range, list, abort, delete) independently of delivery-grant operations.
  Add local and S3 adapters with contract tests and scoped credentials. Object
  paths are opaque; browser-supplied provider URLs/paths are never trusted.
- [x] **V1.4 — Worker runtime.** Ship a separately resource-limited worker image
  and Compose service. Select and document the durable queue mechanism; use the
  existing database for job state, with Redis if selected for queue/cache needs.
  Secrets arrive at runtime, never in jobs, container layers or build arguments.
- [x] **V1.5 — Safe enablement.** Add a default-off feature flag, readiness checks
  and an expandable schema migration. Validate job/storage configuration without
  requiring production credentials for local development.

**Evidence:** [Phase 1 verification](plans/video/evidence/phase-1.md),
[operator runbook](VIDEO_FOUNDATIONS.md). All five foundation tasks are complete;
movie packaging, paid playback and release qualification remain later phases.

**Exit gate:** two workers cannot publish competing results; killing/restarting
a worker resumes or safely retries; missing storage/keys yields a useful setup
error; existing media and payment tests still pass with the feature off.

## Phase 2 — Resumable encrypted ingestion

**Purpose:** turn a large owner upload into one complete immutable video version.

- [x] **V2.1 — Upload protocol.** Add owner-authenticated start, part, status,
  complete and abort operations with same-origin/CSRF protection, upload ownership,
  checksums, idempotency and per-instance byte/job quotas. Require an associated
  product/key before accepting content and block new ingestion during pending key
  rotation. Define resume behavior if rotation begins mid-upload. Persist encrypted
  parts with resumable offsets; direct-to-bucket uploads must encrypt before upload.
  Transport part size is independent of the creator's playback segment duration.
- [x] **V2.2 — Worker input and validation.** Read/decrypt bounded parts through a
  seekable private interface or another Phase-0-proven approach. Validate actual
  container/codecs/tracks, duration, dimensions and resource limits; do not trust
  extension/MIME. Start with the documented H.264/AAC MP4 input profile, with a
  clearly higher configured size limit. Publish exact accepted/rejected examples.
- [x] **V2.3 — Encode and encrypt.** Package the first rendition with continuous
  timestamps and random-access boundaries. Encrypt init/media/manifest as specified
  in `VIDEO_FORMAT.md` before persistence. Constrain FFmpeg CPU, memory, process
  lifetime, input protocols and network access; drain/cancel safely on errors.
- [x] **V2.4 — Atomic publish.** Check object counts, sizes, authentication and
  complete timeline, persist the ready version, then switch the media pointer
  transactionally. Require a valid product association/key state before publishing;
  handle key rotation or product changes during processing explicitly.
- [x] **V2.5 — Creator progress.** Provide upload/processing progress, cancellation,
  actionable validation errors and retries. Abort abandoned multipart uploads and
  failed staging after a documented retention period.

**Exit gate:** a 10 GiB test upload can resume after browser/server interruption;
worker interruption never exposes a partial movie; a complete source produces a
decryptable version with bounded memory. Disk/object inspection and crash tests
find no plaintext staging or raw persisted keys. Oversize/malformed inputs are
rejected without exhausting the web process.

**Evidence:** [Phase 2 verification](plans/video/evidence/phase-2.md),
[operator/API runbook](VIDEO_INGESTION.md), [PPV1 format](VIDEO_FORMAT.md).
The 10 GiB source is a real encrypted/HTTP transfer of a padded synthetic MP4;
client reload is modeled by reconstructing state from server status, alongside
browser-component tests. It is not a two-hour encoding or device playback test.
The protocol uses immutable per-part PUTs, so it creates no native S3 multipart
upload to abandon. Retained staging cleanup is implemented; arbitrary orphan and
paid-version lifecycle remain Phase 5. SatsRail APIs are unchanged.

## Phase 3 — Paid CDN playback

**Purpose:** one real full-length movie through the existing payment/key flow.

Local implementation and tests are complete: [runbook](VIDEO_PLAYBACK.md),
[evidence](plans/video/evidence/phase-3.md). The live/full-film exit gate below is
**not passed**. Both feature flags remain default-off; no deployment occurred.

- [x] **V3.1 — Playback session contract.** Add PrivaPaid session start/renew
  endpoints (proposed `/api/media/[id]/playback-session`). Reuse `access-gate.ts`
  for product/media coverage and SatsRail verification. Return only the necessary
  envelope, immutable version descriptor and bounded delivery grant; keep merchant
  credentials and the buyer's httpOnly macaroon out of CDN requests.
- [x] **V3.2 — Private delivery.** Ship S3/CloudFront setup templates: private
  origin, origin access control, TLS, asset-scoped viewer credentials, CORS and
  cache policies. Choose a tested first-party media-domain/cookie strategy with
  secure cookie scope, credentialed fetch and exact allowed origins. Test multiple
  paid titles/tabs so one grant cannot accidentally authorize or evict another.
- [x] **V3.3 — Player integration.** Add a segmented-video mode to the existing
  payment/player flow. Verify key fingerprints, unwrap keys in memory and decrypt
  ahead into a bounded continuous buffer. Keep decrypted media out of service
  worker/offline caches. Clean up requests, buffers and key references on teardown.
- [x] **V3.4 — Renewal and errors.** Use one session renewal scheduler; avoid
  duplicating existing payment-wall/heartbeat verification for this new mode.
  Jitter renewals before expiry, deduplicate concurrent renewal requests and honor
  throttling/backoff. Distinguish denied access from outages. Never extend grants
  without successful verification or initiate another payment on transient failure.
- [x] **V3.5 — Entitlement bounds.** Set grant expiry to the earliest authoritative
  purchase/token deadline or session limit, with conservative clock/round-trip
  allowance. Enforce deleted/disabled asset state. Existing requests/buffers may
  finish after expiry; document the maximum renewal-based revocation delay.

**Dependencies:** local tests can use contract fixtures; real grants require SR1.
Do not compensate for uncertain expiry by guessing from the product's duration.

**Exit gate:** payment → access cookie → SatsRail key → CDN ciphertext → uninterrupted
playback works for a full movie. Return visits, seeking and renewals work without
paying again. Unpaid/wrong-product/expired/direct-origin requests fail, including
warm-cache requests. Two viewers fetch identical ciphertext objects. Neither
SatsRail nor the PrivaPaid web app proxies production segment bytes.

## Phase 4 — Creator controls and adaptive playback

**Purpose:** make the feature practical across connection speeds and devices.

- [ ] **V4.1 — Quality ladder.** Produce a small tested set of renditions without
  upscaling; align keyframes and audio/video timestamps across renditions. Apply
  one version's selected segment-duration preset consistently across the ladder.
- [ ] **V4.2 — Duration controls.** Expose only qualified presets with estimated
  delivery request count, processing/storage impact and seek/startup tradeoffs.
  Explain that changing segment duration does not change SatsRail renewal calls.
  Changes create a new version; never mutate a playing version.
- [ ] **V4.3 — Continuous playback.** Test automated bitrate adaptation, manual
  quality switches, repeated seeks, audio-only gaps in source content, silent
  movies, pause/resume and network changes. Retry ahead of the playhead; never
  implement playback as a succession of separate video elements.
- [ ] **V4.4 — Accessible creator/viewer UI.** Show readiness, retryable failures,
  processing capacity and storage consumption. Provide keyboard controls and
  sensible unsupported-device/error states; keep implementation jargon out of the
  purchase flow. Finish paginated owner catalog queries for large libraries.

**Exit gate:** each exposed preset passes the same continuity/device matrix;
quality changes have no added black frames, clicks or timestamp drift. Slower
links select an appropriate rendition; memory remains bounded during a two-hour
session and repeated seeking.

## Phase 5 — Lifecycle, recovery and migration

**Purpose:** keep assets, keys and existing purchases usable over time.

- [ ] **V5.1 — Rotation.** Extend existing envelope/product rewrapping for this
  mode without rewriting all segment ciphertext. Test direct and channel products,
  interrupted rotation and recovery. Distinguish routine product-key rotation from
  movie-key compromise, which requires a new key and encrypted asset version.
- [ ] **V5.2 — Garbage collection.** Add dry-run inventory, reference-aware cleanup,
  retention and idempotent deletion for abandoned uploads, failed jobs and retired
  versions. Protect current versions and active-grant windows; handle CDN caches,
  multipart remnants and provider partial failures. Use accounting reconciliation.
- [ ] **V5.3 — Backup and restore.** Document and exercise restoring the database,
  object versions, operator KEK and required delivery credentials. JSON content
  exports contain references, not a portable video backup. Test missing-key/object
  failures explicitly and document credential rotation procedures.
- [ ] **V5.4 — Legacy migration.** Build an opt-in migration from current private
  protected MP4s: decrypt transiently on the operator worker, repackage/re-encrypt
  into a new version, verify and switch. Preserve product associations and paid
  access; retain the old version until rollback/retention requirements are met.
  Do not automatically change existing assets' protection mode.
- [ ] **V5.5 — Failure recovery.** Exercise deleted/replaced media, disabled
  processing, queue loss/rebuild, missing segments and provider outages. Failed
  replacements retain the last working version; cleanup must not race publication.

**Exit gate:** backup restoration on a fresh instance recovers playback; rotation
and migration preserve an existing buyer's access; cleanup proves it cannot delete
referenced/live versions; rollback never depends on reconstructing a lost key.

## SatsRail dependency track

Implement these in SatsRail's own repository, with its normal API tests and release
process. Only the public API contract and compatibility requirements belong here.
The prototype already has `POST /api/v1/m/access/verify`: valid paid product access
returns `valid`, product/order identifiers, `key`, `key_fingerprint` and
`remaining_seconds`. No media-specific SatsRail endpoint is required.

- [x] **SR1 — Authoritative expiry (blocks real CDN grants).** Return remaining
  access no greater than both macaroon lifetime and paid entitlement. Cover a
  long-lived token with seconds of entitlement left, expiry, revoked/unpaid orders
  and product-duration changes. Implemented and locally tested with absolute `expires_at`/`server_time`; video
  sessions require those fields. Deploy this prerequisite before enabling playback. Retain
  merchant/product/order checks and the separate payment/key operations.
- [ ] **SR2 — Verification budget (blocks scale qualification).** Establish
  measured minute and hourly budgets for session starts, renewals, retries and
  other merchant traffic. Preserve abuse controls and clear retry responses;
  do not indiscriminately lift all API limits or introduce stateless local
  macaroon acceptance as a quota workaround.
- [ ] **SR3 — Capacity and response handling (blocks production release).** Measure
  startup/renewal bursts, database pool pressure and tail latency. Verify no-store
  behavior for key-bearing responses and proxy responses, token/key scrubbing,
  timeout semantics and compatible responses for current clients.

Sizing: for `N` viewers and an actual average verification interval of `T` seconds,
renewals alone are approximately `N / T` requests/second and `N × 3600 / T` per
hour. At 5,000 viewers and a 240-second interval, that is about 21/second or
75,000/hour, plus starts/retries. Grant TTL and renewal interval differ when
renewing early. Separate playback segment count and SatsRail call count in metrics.
Do not share one buyer's paid authorization with another buyer to reduce calls.

## Phase 6 — Security, devices and scale qualification

**Purpose:** establish evidence for the capacity and playback claims.

- [ ] **V6.1 — Security suite.** Test every boundary: owner/upload permissions,
  cross-product and cross-asset access, malformed manifests, GCM tampering, nonce
  safety across retries, key rotation, cache-hit authorization, expired grants,
  origin bypass, credential leakage and key-response caching. Include tests of
  both real cryptography and the actual CDN configuration.
- [ ] **V6.2 — Playback matrix.** Use real devices for two-hour playback, repeated
  seek/switch, background/foreground, mobile network handover and constrained
  memory. Synthetic HTTP traffic cannot establish decoding or continuity quality.
- [ ] **V6.3 — Traffic harness.** Simulate segment fetches, session verification,
  seeks, renewals and mixed assets at 1,000, 5,000 and 10,000 viewers. Include cold
  and warm caches, viewers arriving together and many small independent operators.
  Report synthetic clients separately from real decoding browsers.
- [ ] **V6.4 — Failure/load isolation.** During playback inject SatsRail 429/5xx,
  CDN/object failures and worker restarts; simultaneously ingest a movie. Verify
  media processing cannot exhaust checkout resources and outage recovery never
  double-charges or silently lengthens access.
- [ ] **V6.5 — Report and tuning.** Capture player startup/rebuffer/seek metrics,
  authorization p95/p99, request errors, CPU/RAM, queue depth, object/request counts,
  CDN hit ratio, origin bandwidth and estimated provider cost per viewing hour.
  Record machine sizes, regions, bitrates, browser versions and test duration.

### Proposed release criteria

Freeze profiles and thresholds in Phase 0; any change needs a documented reason
and a new measurement. These are acceptance targets, not current guarantees.

| Measure | Target and test conditions |
|---|---|
| Playback continuity | Zero segment-boundary-induced stalls, black frames or audio clicks in the two-hour fixture on each supported device/preset; no cumulative A/V drift and at most 80 ms measured sync error |
| Startup / seek | p95 ≤3 s to first frame after a user play gesture and entitlement verification, and p95 ≤2 s seek-to-frame; warm CDN, 50 ms RTT, available bandwidth ≥2× rendition bitrate |
| Rebuffering | <0.5% playback time after startup on that stable network profile; report degraded-network results separately |
| Authorization | At the published load, p95 ≤300 ms, p99 ≤1 s and <0.1% unexpected failures; separately test invalid requests, throttling and cold connections |
| Memory | Set a measured ceiling per target device/worker profile in Phase 0; memory plateaus with a bounded buffer and does not grow with movie duration |
| Capacity | Sustain 1,000 concurrent sessions for two hours as a preliminary gate, then 5,000 for two hours on the published release profile; 10,000 remains a stretch result unless it passes |
| Isolation | Segment delivery adds zero video-byte traffic to SatsRail/web instances; encoding cannot violate the measured checkout/authorization objectives |
| Access | No grant extends beyond authoritative expiry; all wrong-product/tamper/origin-bypass cases rejected, with no secrets in captured logs |
| Cost | Publish storage, processing, requests and delivery estimates with provider/date/region assumptions and the measured object layout |

**Exit gate:** SR1–SR3 and applicable release criteria pass. Failed measurements
return to the owning phase. Publish supported capacity only for the tested
configuration; document unsupported devices and the 10,000-viewer result honestly.
Live provider tests need an operator account and an explicit test-spend ceiling;
continue local simulation while that external prerequisite is unavailable.

## Phase 7 — Operator packaging and staged release

**Purpose:** make the feature deployable by someone who did not build it.

- [ ] **V7.1 — Complete distribution.** Ship coordinated web/worker images,
  Compose profiles, migrations, local fixtures and provider/edge templates here.
  Pin dependency versions and include required license notices and redistribution
  material for the exact player/FFmpeg builds shipped.
- [ ] **V7.2 — Operator guide.** Document credentials and least-privilege policies,
  domains/TLS/CORS, accepted uploads, duration/quality presets, worker sizing,
  cost estimation, alarms, backup/restore, retention and troubleshooting. Keep
  public instructions self-contained; never link to private SatsRail documents.
- [ ] **V7.3 — Clean-install rehearsal.** From a clean clone, configure the local
  profile, then the supported cloud profile, upload a movie and complete paid
  playback using published instructions. Exercise configuration validation and
  useful errors for missing/invalid credentials.
- [ ] **V7.4 — Canary and rollback.** Enable for one operator and new assets first;
  expand after health criteria hold. Separate upload enablement from playback so
  pausing ingestion does not strand purchases. An older app cannot play the new
  format: retain a compatible playback service/version or tested prior asset
  until all affected media are migrated. Test before broad rollout.
- [ ] **V7.5 — Release record.** Attach phase evidence, minimum SatsRail contract,
  exact supported devices/provider settings, measured capacity and known limits.
  Mark this plan delivered only when install, upgrade, restore and rollback pass.

**Exit gate:** another operator can deploy the complete feature from this repo,
serve a paid movie, recover it from backup and perform the documented rollback.
Neither a private PrivaPaid worker service nor undocumented manual cloud changes
are required.

## Follow-on work after the first qualified release

- R2 and other providers: implement the same storage/delivery contracts; rerun
  authorization, CORS/cache, lifecycle and real-device tests for each provider.
- Expand source containers/codecs, subtitles and alternate audio with explicit
  validation and continuous-timeline tests.
- Revisit 4K, live streaming, offline playback, casting/native apps and commercial
  DRM as separate scopes with their own compatibility and protection decisions.

## How to execute and record a phase

1. Read this plan, the owning phase and current source. Confirm predecessor gates
   and existing working-tree changes before editing. Use `feature/video-…` or
   `fix/video-…` branches and focused PRs; keep SatsRail and PrivaPaid changes in
   their own repositories with explicit API dependencies.
2. Implement one independently reviewable task or small group. Add meaningful
   model/service/API tests with code changes, using real crypto for format tests.
   Keep generated movies, secrets and raw customer traffic out of Git.
3. Run relevant Vitest tests, `npm run typecheck` and `npm run lint`; run
   `npm run build` for runtime/player/package changes. Run the existing decryption
   suite (`npm run test:decryption`) for envelope/payment changes, using the
   repository test database setup. Add documented worker/browser/load commands
   when those harnesses exist; do not claim these checks prove CDN/device behavior.
4. Put a sanitized evidence report in `plans/video/evidence/phase-N.md`: commits,
   commands, environment, measurements, failures/limitations, decisions and next
   task. Record SatsRail dependency status/version without copying private internals.
5. Check completed tasks and update the tracker only after its exit gate passes.
   A blocked external check stays visible; it is not silently waived. Update
   `VIDEO_FORMAT.md` and operator documentation with every accepted format change.

`VIDEO_FORMAT.md` and Phase 0/1 evidence now exist; later phase evidence files are
created during execution. This plan stays at repository root because the current `/docs/` folder
is ignored by Git; public execution evidence must be distributable with the code.

### Execution record

| Date | Phase/task | Result / evidence | Next action |
|---|---|---|---|
| 2026-09-25 | Planning | Phases and acceptance criteria written; no runtime changes or cloud resources | Begin V0.1 |
| 2026-09-26 | Language baseline | Recommend existing TypeScript/Node and Ruby stacks with FFmpeg/native crypto; optional Rust follows profiling | Measure worker stages in V0.5 and authorization in SR3 |
| 2026-09-26 | V0.1 / V0.3 / V0.4 | Local fixture generator, experimental PPV0, Shaka playback and crypto/timeline tests implemented; see Phase 0 evidence | V0.2 real-device and full-duration qualification; V0.5 decisions |
| 2026-09-26 | V1.1–V1.5 | Versioned metadata, Postgres leases/fencing/recovery, local/S3 adapters, isolated worker, owner setup API and default-off configuration; [evidence](plans/video/evidence/phase-1.md) | V2.1; retain open Phase 0/release gates |
| 2026-09-26 | V2.1–V2.5 | Resumable encrypted 10 GiB ingestion, private seekable FFmpeg input, PPV1, atomic validated publication, creator progress/retry/cancel and retention cleanup; [evidence](plans/video/evidence/phase-2.md) | V3.1; retain open Phase 0/release gates |

## Technical references

Use primary documentation during implementation and record the exact versions
tested. These references support the candidate design, not a claim of completed
integration.

- [Shaka Player](https://github.com/shaka-project/shaka-player) — maintained player candidate; check encryption and device-specific support for the chosen format.
- [ISO BMFF byte stream format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/) — initialization/media segment structure and continuous media-buffer input.
- [CloudFront signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html) — separate CDN credential, scope and expiry handling.
- [CloudFront private S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html) — private origin configuration.
