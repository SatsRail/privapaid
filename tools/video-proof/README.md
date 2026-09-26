# Encrypted video proof

Standalone Phase 0 lab for [the execution plan](../../ENCRYPTED_VIDEO_PLAN.md).
No production routes, database migrations, merchant credentials or cloud accounts
are used. The application does not import this directory.

**Synthetic content only.** Keys are public test material. This proves the media
format/player integration, not paid access, DRM or production security. Never
deploy the lab server or use its key scheme for customer content.

## Prerequisites

Node 22+, npm, FFmpeg/FFprobe with libx264, AAC and the DASH muxer, plus Chrome for
browser tests. The checked lockfile pins Shaka 5.2.12 and Playwright 1.62.1.
The generator needs local loopback sockets. `FFMPEG_PATH` and `FFPROBE_PATH` may
select explicit binaries. No drawtext/font dependency is required.

```sh
cd tools/video-proof
npm ci --ignore-scripts
npm test
mkdir -p .artifacts
npm run fixture -- --output .artifacts/smoke-4 --seconds 42 --segment 4
npm run validate -- --fixture .artifacts/smoke-4
npm run test:browser -- --fixture .artifacts/smoke-4
npm run serve -- --fixture .artifacts/smoke-4
```

Open `http://127.0.0.1:4317` and click **Start playback**. It serves encrypted
objects; the browser decrypts them before Shaka reads them. The lab uses a single
video element and separate fMP4 audio/video tracks. Its JSON metrics are diagnostic.

Use a **new output directory** for every generation. Existing output is never
overwritten, including incomplete runs. Delete unwanted fixture directories only
when finished with their evidence. `.artifacts/` and nested dependencies are
ignored; source, lockfile and sanitized reports are distributable.

For the second duration and long-form validation:

```sh
npm run fixture -- --output .artifacts/smoke-10 --seconds 42 --segment 10
npm run validate -- --fixture .artifacts/smoke-10
npm run test:browser -- --fixture .artifacts/smoke-10
npm run fixture -- --output .artifacts/full-4 --seconds 7202 --segment 4
npm run validate -- --fixture .artifacts/full-4
npm run test:browser -- --fixture .artifacts/full-4 --sample 12
```

Repeat long-form generation/validation with `--segment 10`. Duration 7202 seconds
deliberately exercises the final partial segment. `--sample 12` plays the start,
seeks to the midpoint/90%/end, and exercises restart/pause/negative tests. **It is
not a two-hour playback soak.** Omit `--sample` for normal-speed full playback;
that takes the movie's actual duration.

For a second desktop engine:

```sh
npx playwright install webkit
npm run test:browser -- --fixture .artifacts/smoke-4 --browser webkit
```

Playwright WebKit is not a qualification of shipping Safari or iOS hardware.
Physical-device and perceptual audio checks remain part of Phase 0's exit gate.

## Outputs and verification

- `fixture.json`: completion marker, identities, public-key marker, checksums,
  exact FFmpeg configuration, timing and generator RSS snapshot (not peak RSS).
- `validation.json`: whole-fixture decrypted packet counts, timing and keyframes.
- `browser-{engine}.json`: exact browser version, test mode, successes/failures,
  decoding/buffer metrics and encrypted delivery counters.
- `browser-{engine}.png`: visible player after the playback/seek checks.

The browser tests reject modified tags and valid ciphertext substituted from a
different segment. The server denies foreign origins. Buffer bounds are measured
in seconds, and browser heap values are snapshots when available; neither is a
claim of two-hour memory stability or real-world bitrate/device capacity.

Read [VIDEO_FORMAT.md](../../VIDEO_FORMAT.md) before changing the cryptography or
object layout. Run `npm test`, both fixture validators and affected browser tests
after changes. From the repository root, lint with
`npx eslint tools/video-proof/*.mjs` and run `npm run typecheck`.
