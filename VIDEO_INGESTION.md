# Encrypted video ingestion (Phase 2)

The opt-in pipeline accepts resumable owner uploads, encrypts stored source parts,
and creates one validated, immutable DASH rendition. It remains experimental and
disabled by default. Phase 3 adds paid browser/CDN playback; preparing a video
here does not replace the existing buyer player. Physical-device and continuous
two-hour playback qualification from Phase 0 remain release requirements.

## Creator workflow

1. Create a video media record and associate an active paid product. The existing
   media envelope and product-wrapped media DEK must be valid.
2. As owner, open the media edit page, then **Prepare large video (experimental)**.
3. Select an MP4 and either 4-second or 10-second playback segments. Start upload.
4. Pause or reload safely. Reselect the original file and resume from the saved
   offset. Uploads expire 24 hours after creation; resume does not extend expiry.
5. Watch queued/processing progress. Cancel an unfinished version, or retry a
   failed job while its source is retained. Failures preserve the previously
   prepared version. Processing produces a ready version for Phase 3 integration.

Accepted: MP4 with exactly one H.264/AVC `yuv420p` video track, optionally one AAC
audio track; 16×16 through 3840×2160, up to 60 fps, up to four hours, and at most
10 GiB (10,737,418,240 bytes). Video-only MP4 is supported. Actual container and
tracks are inspected with FFprobe; filename and MIME do not establish acceptance.

Rejected examples: WebM/VP9, MKV, HEVC MP4, ProRes, 10-bit/4:2:2 H.264, extra audio
tracks, embedded subtitle/data/cover-art tracks, malformed/truncated MP4, an MP4
over configured duration/dimensions, or any source over 10 GiB. A quick first-part
`ftyp` check precedes full post-upload validation. This is deliberately a narrow
first input profile, not a general media conversion service.

Output: H.264 Main, at most 1280×720 without upscaling, 30 fps, optional stereo
AAC 48 kHz/128 kbps. FFmpeg encodes one continuous timeline; segments start at
regular video keyframes. Every packet and every persisted object is checked
before publication. This is one rendition, not adaptive bitrate streaming.

## What lives where

PostgreSQL stores identities, progress, leases, byte reservations, hashes, wrapped
movie roots and a small encrypted descriptor. It stores no source movie, segment
array or plaintext media. Source parts, manifests, init/media objects and the
encrypted inventory live in private local storage or S3 through the existing
adapter. See [PPV1](VIDEO_FORMAT.md#ppv1-phase-2-ingestion-format).

The web route receives plaintext over TLS, buffers one bounded 8 MiB part and
encrypts before any application storage write. This is server-side ingestion
encryption, not browser-to-bucket direct upload. Reverse proxies must also avoid
plaintext request-body spooling. FFmpeg reads authenticated parts via a random,
loopback-only HTTP capability with seek/range support, and sends output to the
same private bridge. Plaintext source/segment files are never needed.

SatsRail receives only existing merchant product/key requests. It receives no
movie, filename, duration, manifest, storage locator or new video API call.
Macaroons remain payment authorization, never encryption keys. Upload parts and
playback segment duration are independent; neither requires one SatsRail call
per part or segment.

## Product changes and publication

Start, resume, complete, retry, processing start and pre-publication validate the
remote active product/current key and reject pending `old_key` rotation. Each
part also verifies the pinned local access chain. A remote-only rotation begun
between checkpoints may allow more **encrypted staging** parts; completion and
publication pause until the product/media DEK wrapper is consistent again.
Resume can bind to the new product key once rotation is completed, without
reuploading saved parts. Replacing the media DEK/envelope requires a new upload.

Before publication, the worker authenticates all ciphertext, checks exact object
inventory, manifest duration and every track's packet continuity/keyframe
boundaries, then fetches fresh product/key state. It locks the local access
chain, newest asset generation and job lease in one database transaction. Ready
metadata, encrypted descriptor, completed job and published pointer commit
together. A stale/cancelled worker cannot publish; each retry writes a distinct
immutable attempt prefix. An older generation cannot replace a newer one.

There is no distributed transaction with SatsRail: remote validation is a
point-in-time check, and subsequent rotation preserves the existing media DEK.
Phase 3 must still authorize each buyer's key/session through the payment layer.

## Operator configuration

Follow [VIDEO_FOUNDATIONS.md](VIDEO_FOUNDATIONS.md) for shared local/S3 storage,
IAM, the default-off flag, owner readiness APIs and deployment. Apply migrations
and build both app and worker. In addition to `DATABASE_URL` and the same
`CONTENT_KEK`, the worker needs the same `SK_ENCRYPTION_KEY` that unwraps the
merchant secret in Settings, and `SATSRAIL_API_URL` if overriding the default.
It must reach PostgreSQL, private storage and SatsRail.

| Variable | Default | Purpose |
|---|---:|---|
| `VIDEO_MAX_STORAGE_BYTES` | 107374182400 | Global reservation budget (100 GiB) |
| `VIDEO_MAX_PENDING_JOBS` | 4 | Combined uploading/queued/processing versions |
| `VIDEO_MAX_ACTIVE_TRANSFERS` | 2 | Active part requests across web replicas |
| `VIDEO_MAX_DURATION_SECONDS` | 14400 | Input duration limit, cannot exceed 4h |
| `VIDEO_ENCODING_THREADS` | 2 | Native encoder threads |
| `VIDEO_ENCODING_TIMEOUT_SECONDS` | 28800 | Whole processing attempt deadline (8h) |
| `VIDEO_STAGING_RETENTION_SECONDS` | 86400 | Retain terminal staging (24h) |
| `VIDEO_MIN_FREE_BYTES` | 1073741824 | Local free-space reserve before part writes |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Native binaries |

Source transport parts are fixed at 8 MiB, with a smaller last part. Objects
are bounded to 32 MiB plaintext, 10,000 objects and 8 GiB per processing attempt.
Admission reserves source bytes plus encryption overhead and three 8 GiB output
budgets before accepting content. An explicit processing retry adds one attempt
and another 8 GiB reservation, with at most ten attempts total. Conservative
reservations prevent concurrent jobs across replicas from oversubscribing the
configured budget. They are not a guarantee of actual free disk space.

The worker handles one job at a time. Compose uses a separate non-root container
with two CPUs, 2 GiB RAM, equal RAM+swap limit (no additional container swap),
128 processes, no core dumps, read-only root and a 64 MiB tmpfs. FFmpeg receives
no database/cloud/key environment, only PATH/locale; input is forced to the MOV
demuxer with external references disabled and HTTP/TCP restricted to the private
bridge supplied by the worker. Validation stdin permits only the pipe protocol.
The bridge checks host/path/capability, caps concurrent requests and wire bytes,
and retains provisional manifests only in RAM. Output must pass all checks even
if FFmpeg exits successfully. Abort/timeout kills and drains the child process.

These controls do not turn FFmpeg into a memory-safe parser. Keep the container
and native dependencies patched. Native development outside Compose must provide
equivalent CPU/RAM/process, swap/core-dump and disk controls. Protect host swap,
backups and the filesystem; JavaScript buffer clearing cannot erase all copies
of transient keys or media in runtime memory.

For the raw part endpoint, allow 8 MiB requests and disable proxy request
buffering/spooling. Allow at least 150 seconds upstream timeout; the app aborts
part reception at 110 seconds and its database request lease expires at 120.
Set `AUTH_URL`/`NEXTAUTH_URL` to the canonical HTTPS origin. For example, in the
existing TLS server (replace upstream with your app):

```nginx
location ~ ^/api/admin/video-pipeline/uploads/[^/]+/parts/?$ {
    client_max_body_size 8m;
    proxy_request_buffering off;
    proxy_http_version 1.1;
    proxy_read_timeout 150s;
    proxy_pass http://privapaid_app;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Next middleware excludes only this raw part route to avoid cloning/buffering
large bodies. Each route independently requires owner authentication, ownership
and exact same-origin mutation. JSON bodies are capped at 4 KiB. Responses are
`no-store` and expose only safe status/error fields, never keys or provider paths.

## Protocol and recovery

All endpoints begin `/api/admin/video-pipeline/uploads`:

| Method/path | Contract |
|---|---|
| POST `/` | `{mediaId,productId,bytes,segmentSeconds,clientFingerprint,idempotencyKey}`; UUID creation key |
| GET `/?mediaId=…` | Last ten owned sessions, newest first |
| GET `/:id` | Saved offset, progress, safe error and expiry |
| PUT `/:id/parts` | Raw bytes; `Upload-Offset`, `X-Content-SHA256`, `Content-Type: application/octet-stream` |
| POST `/:id/resume` | Refresh valid product binding before resuming |
| POST `/:id/complete` | Queue exactly once when every source byte is acknowledged |
| POST `/:id/retry` | Fresh key/quota checks; one extra processing attempt |
| DELETE `/:id` | Cancel unfinished upload/job, retain staging until cleanup |

Offsets are sequential 8 MiB boundaries. Retrying an acknowledged part or an
object saved immediately before a server crash succeeds only if its authenticated
plaintext checksum matches. A conflicting immutable object is never overwritten.
The browser fingerprints size and first/last 64 KiB to catch accidental file
selection errors; this is not a whole-file digest. SHA-256 protects each transfer
part and the worker computes a whole-source digest before decoding.

Once per minute, each worker can lease a terminal version for cleanup. After the
retention window it deletes sources and losing attempts, preserving the winning
ready attempt, and releases unused reservation bytes. Failed/cancelled versions
release all reservations. Expired open uploads become eligible after expiry plus
retention. Cleanup leases exclude retries. Interrupted local atomic puts are also
removed after retention. Source cleanup makes a fresh upload necessary for retry.

This ingestion protocol uses individual immutable S3 PUTs, not native S3 multipart
uploads, so it creates no provider multipart IDs to abandon. Keep an S3 lifecycle
rule to abort incomplete multipart uploads for other/future adapter consumers.
Paid-version deletion, arbitrary orphan discovery and backup lifecycle remain
Phase 5. Use a private bucket; no public ACL or CDN access is enabled here.

Verification and reproducible commands: [Phase 2 evidence](plans/video/evidence/phase-2.md).
