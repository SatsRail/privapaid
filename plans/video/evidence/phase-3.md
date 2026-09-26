# Phase 3 local evidence — 2026-09-26

Status: implementation complete locally; production/full-film exit gate open.
Nothing was enabled or deployed by this task. [Runbook](../../../VIDEO_PLAYBACK.md).

## Browser evidence

[Machine-readable Chrome result](phase-3-chrome.json), Chrome 153.0.8010.53 on
macOS ARM64, 28-second generated H.264/AAC DASH movie, 4-second video segments,
RSA-SHA256 delivery cookies, PPV1 AES-256-GCM/Web Crypto and Shaka 5.2.12.

- All 840 video frames decoded; no post-startup `waiting` events during linear
  playback; maximum observed buffered span 23.999999 seconds.
- Two paid titles in two tabs; eight Secure/httpOnly cookies on two distinct
  attempt paths. Both sessions renewed four times including their initial start.
- No payment macaroon reached the media hostname. Real browser HTTPS/CORS/cookies;
  no interception that bypassed those boundaries.
- Playback to final segment, backward seek, authorized warm reads, denial without
  cookies, denial after actual cookie expiry, and no renewals after teardown passed.

Command: `VIDEO_BROWSER_TEST=true VIDEO_BROWSER_REPORT=plans/video/evidence/phase-3-chrome.json npm run test:video-playback`.
The test starts from a paid-contract fixture, not a real Lightning transaction.
It uses the local delivery adapter, not a live CloudFront cache. Frame counts and
waiting events do not replace visual/audio inspection on physical devices.

## Server and crypto evidence

Combined affected regression suite: 217 PrivaPaid tests passed; two opt-in tests
were skipped in that batch (browser proof ran separately; the Phase 2 10 GiB
restart test was not rerun). SatsRail's affected request suite: 33 passed.
The final session/UI run also passed 70 tests, including an additional
local-state-change-during-verification regression (218 distinct PrivaPaid tests
verified across the runs). TypeScript, scoped ESLint and production webpack build
passed. The build retains existing Sentry configuration/deprecation and missing
optional OpenTelemetry Winston transport warnings.

Tests cover the real PrivaPaid playback route and existing access gate with
PostgreSQL and a SatsRail contract fixture: covering-product checks, short
entitlement bounds, older/malformed API response rejection, outages/Retry-After,
wrong product, absent payment, disabled/deleted state, output-only delivery,
expiry after successful reads, and identical ciphertext across reads.

Browser crypto tests use actual worker-format encryption, key wrapping and Web
Crypto decryption. They reject altered tags/hashes, wrong key fingerprints,
product AAD substitution and version substitution. Renewal tests prove concurrent
request deduplication, no grant extension during 429, and terminal denial.
Payment UI tests prove one initial session handoff with no legacy decrypt/unlock
or focus heartbeat for an active segmented movie.

SatsRail request tests cover both secret and publishable verification surfaces:
shorter purchase/token lifetime, exact expiry, changed product duration, revoked
order and changed order-line coverage. The original payment and key operations
remain separate, stateful and content-blind.

The ingestion fingerprint check now follows SatsRail's established SHA-256 of the
base64url key **string**, matching existing browser crypto. The earlier Phase 2
fixture had incorrectly used decoded key bytes. A regression rejects that form;
real ingestion tests pass with the established contract.

## Deployment evidence and remaining gates

The supplied CloudFormation JSON passes `cfn-lint 1.46.0`. It has not been applied
or tested against AWS. Local protocol tests cannot establish live OAC, edge-cache,
CORS, key-group propagation or signed-cookie behavior. Run those checks against a
private staging distribution before production use.

Still required: full-length movie through real purchase/key/CDN flow; actual
Safari/iOS/Android and Firefox playback; long-session memory and seek behavior;
real outage/recovery on devices; key rotation and retained-version lifecycle;
security review and measured SatsRail minute/hour verification budgets and tail
latency. The feature remains opt-in/default-off pending these gates. Phase 4
renditions/creator controls and Phase 5 lifecycle are not implemented here.
