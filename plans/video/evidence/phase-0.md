# Phase 0 evidence — 2026-09-26

**Status: in progress.** Local format/player proof implemented on
`feature/video-format-proof`; changes are in the working tree. The production
application, SatsRail, schema and cloud infrastructure have not changed.

## Delivered

- [Standalone proof](../../../tools/video-proof/README.md), with its own locked
  dependencies and commands; generated assets are ignored by Git.
- Synthetic FFmpeg fixture generation at 4/10-second segment targets. Plaintext
  flows over an ephemeral loopback sink and is encrypted before any media file is
  written. Completed output is immutable; incomplete output cannot be served.
- [PPV0 specification](../../../VIDEO_FORMAT.md): AES-256-GCM, per-object HKDF
  keys, authenticated movie/version/object identity, encrypted init and manifest.
- Shaka 5.2.12 with a Web Crypto response filter, continuous playback, bounded
  buffering and a local diagnostic UI. Public fixture keys only; no paid access.
- Automated cryptography, packet-timeline and real-browser playback checks.

Exact commands are in the proof README. Machine-readable results, versions,
generation arguments and measurements are in [phase-0-results.json](phase-0-results.json).
Environment: Apple Silicon macOS, Node 25.8.1, FFmpeg/FFprobe 8.1.2,
Chrome 153.0.8010.53, Playwright WebKit 26.5 (build 2336), Playwright 1.62.1.

## Fixture and timeline results

| Source duration | Segment target | Encrypted objects | Whole-fixture packet validation |
|---|---|---|---|
| 42 s | 4 s | 25 | Pass: 1,008 video frames, 11 video keyframes, 1,970 AAC packets |
| 42 s | 10 s | 13 | Pass: 1,008 video frames, 5 video keyframes, 1,970 AAC packets |
| 7,202 s | 4 s | 3,605 | Pass: 172,848 video frames, 1,801 video keyframes, 337,595 AAC packets |
| 7,202 s | 10 s | 1,445 | Pass: 172,848 video frames, 721 video keyframes, 337,595 AAC packets |

Every encrypted object was authenticated/decrypted and compared with its source
SHA-256 checksum. Both track end times matched each fixture duration. The largest
adjacent packet discrepancy was approximately one microsecond (FFprobe's printed
timestamp precision). The final partial fragments were included. AAC encoder
priming starts at -0.021333 seconds; both tracks finish at the intended endpoint.

These are complete encoded timeline checks, not a claim of two-hour browser
playback, perceptually perfect audio, or measured audio/video rendering sync.

## Browser results

| Engine / preset | Mode | Startup (one run) | Maximum buffered span | Outcome |
|---|---|---|---|---|
| Chrome / 4 s | Full 42 s at normal speed | 300 ms | 24 s | Pass; zero rebuffer events after start |
| Chrome / 10 s | Full 42 s at normal speed | 163 ms | 30 s | Pass; zero rebuffer events after start |
| WebKit / 4 s | Full 42 s at normal speed | 238 ms | 24 s | Pass; zero rebuffer events after start |
| WebKit / 10 s | Full 42 s at normal speed | 156 ms | 30 s | Pass; zero rebuffer events after start |
| Chrome / 4 s, two-hour asset | First 12 s + midpoint/90%/end seeks | 386 ms | 24 s during start sample | Pass; full-duration soak pending |
| Chrome / 10 s, two-hour asset | First 12 s + midpoint/90%/end seeks | 202 ms | 30 s during start sample | Pass; full-duration soak pending |

All six runs checked backwards/forwards seeking, pause/resume, final-fragment
playback, corrupted tags and substituted video segments. Tampered first video
fragments were rejected before any decoded video frame. Foreign-origin requests
to the fixture session were denied. Screenshots were inspected locally.

Frame-drop telemetry matters: the four-second Chrome smoke run reported two
dropped frames; its concurrent long-fixture start sample reported eight. The
ten-second Chrome runs and both WebKit smoke runs reported zero. The tests ran
alongside encoding/other browser work, so this is not a device performance
qualification or proof of the cause. Measure controlled runs and perceptual
continuity before claiming seamless playback on a particular device. Startup
numbers are single local observations, not p95 values or production/CDN estimates.

## Checks run

- `cd tools/video-proof && npm test`: **10 passed**, including independent
  HKDF/AES-GCM known answers, native/browser crypto interoperability, tampering,
  wrong identities, malformed input and immutable-output retry denial.
- Both 42-second and both 7,202-second `validate` runs: **passed**.
- Four short real-browser runs and two long-fixture sampled runs: **passed**.
- `npm run typecheck`: **passed**.
- `npx eslint tools/video-proof/*.mjs`: **passed**.
- Repository-wide `npm run lint`: **zero errors**; four warnings in unchanged
  appearance/login/setup files about existing location-based navigation.
- Existing `protected-video.test.ts` and `protected-video-probe.test.ts`:
  **25 passed**. The existing delivery mode remains separate.

The proof has no application import or production build step. A production
Next.js build was not used to claim anything about the isolated browser harness.
The development harness and generated movies are excluded from the production
Docker context to avoid shipping test dependencies or large local fixtures.

## Decisions and remaining gates

The candidate is DASH/fMP4 with a Shaka networking adapter, because that preserves
AAD binding without forking a player or relying on native HLS GCM behavior. Node
orchestrates FFmpeg/native crypto; these results do not establish a need for Rust.
The generator's reported RSS is a snapshot, not peak memory. CPU/encoding/crypto,
copying and object-I/O profiling remains incomplete.

- V0.1: delivered generators, exact versions, checksums and both short/long presets.
- V0.3: experimental format and proposed product-envelope integration documented;
  production schema, key wrapping and security review remain future integration.
- V0.4: local vectors, actual browser decryption and negative cases pass.
- V0.2 remains open for shipping Safari and physical iPhone/iPad/Android devices,
  plus uninterrupted full-duration playback, audio inspection and memory ceilings.
- V0.5 remains open for the final device floor, profile selection, resource/cost
  measurements, review of worker input/crash handling and production format freeze.

**Do not advance through Phase 0's release gate yet.** The first remaining task
is V0.2: run the reproducible harness on the required devices and perform the
normal-speed two-hour soak. Paid session/CDN authorization, resumable input,
multi-quality delivery and production operator packaging remain later phases.
