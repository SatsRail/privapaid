# Adaptive encrypted video (Phase 4)

Phase 4 adds adaptive quality, creator estimates and a paginated video library.
It is implemented locally behind the existing **default-off** pipeline/playback
flags. Both segment presets have local Chrome evidence. Live CDN, physical-device,
two-hour memory/continuity and scale qualification remain open; this is not a
production or studio-grade protection claim. See [evidence](plans/video/evidence/phase-4.md)
and the [execution plan](ENCRYPTED_VIDEO_PLAN.md).

## Quality and continuous playback

New uploads use `h264-aac-abr720p30-v1-experimental`. The worker creates up to three
H.264 Main renditions fitting 640×360, 854×480 and 1280×720, with target video rates
of 500, 900 and 1,800 kbps. Peak rates are 750, 1,250 and 2,300 kbps. It never
upscales; duplicate dimensions are omitted. Dimensions round down to even pixels
and FFmpeg preserves display aspect ratio through the output sample aspect ratio
(for a 16:9 source the middle rendition is 852×480). Sources must have square
pixels; orthogonal rotation metadata is applied before choosing output sizes.

One frame timeline is normalized to 30 fps and split into the rendition encoders.
All qualities share keyframe/segment boundaries. There is at most one shared AAC
48 kHz/128 kbps stereo audio track; switching video quality does not switch audio.
Missing source video frames are held and audio gaps padded. A source with no audio
has no audio adaptation set. The worker verifies inventory, actual packet
continuity and each quality's keyframes before atomic publication.

The viewer has a labelled **Auto / quality** selector and native video controls.
Auto begins conservatively and samples actual encrypted download progress,
excluding key renewal, decryption and local queue time. Ordinary network failures
can retry; failed authentication is fatal. Manual and automatic switches preserve
already-buffered media, so a resolution change can take several seconds to appear.
No buffer clearing or succession of video elements is used for quality changes.
A sudden drop below the buffered rendition's needs can still cause rebuffering.

The existing session lease, key chain, per-attempt cookies and two concurrent
fetch/decrypt operations are unchanged. No SatsRail changes are needed for Phase 4.
SatsRail still verifies payment and supplies keys through the Phase 3 contract;
media files, manifests, segment choices and storage locations remain in PrivaPaid.

## Creator controls

Open **Video library** from the preparation screen, or `/admin/videos` as owner.
The library searches media names and loads 25 assets per page using a bounded
keyset query. It distinguishes the latest version from the published version.
Deleted media/channels are excluded. Owner-only `GET /api/admin/video-pipeline/assets`
accepts `limit` (1–100), `cursor` and `q` (at most 100 characters).

The upload screen previews dimensions, output size, object/request counts and
relative encoded pixel work from local file metadata. The worker independently
validates the source. Runtime depends on the worker, source and storage; pixel
work is explicitly **not** a processing-time prediction.

| Preset | For a 2-hour movie with audio | Tradeoff |
|---|---:|---|
| 4 seconds (recommended) | About 3,604 delivery requests/view | Quicker response to seeks and connection changes |
| 10 seconds | About 1,444 delivery requests/view | Fewer requests; each segment takes longer to fetch |

These counts assume one video quality plus audio, one complete view, and initial
catalog/manifest/init requests. Seeks, retries and quality switches add requests.
Storing all three qualities needs about 7,206 objects at 4 seconds or 2,886 at
10 seconds. Target-rate output for two hours is about 2.93 GiB including a 5%
overhead allowance, in addition to retained source files and older versions.
Actual bytes vary. **Segment duration does not change SatsRail renewal calls.**

Changing the preset requires a new upload/version. A new key and immutable prefix
are allocated; processing failure cannot replace the published version. Existing
single-quality versions remain playable and queued legacy-profile jobs remain
single-quality. Deploy the updated worker and web app together before enabling
new uploads; older workers cannot process the new profile.

## Capacity and limits

Owner-only `GET /api/admin/video-pipeline/capacity` reports worker readiness,
queued/processing versions, occupied admission slots, encrypted output and byte
reservations. Responses are uncached. Creator screens poll every 15 seconds while
mounted. Reservations include source storage and retry allowance; output bytes
are not total provider usage or a billing estimate. Retained versions count.

Output is bounded to **15,000 objects**, enough for a four-hour, four-track movie
at four-second segments, and **8 GiB per attempt**. The encrypted catalog remains
bounded to 4 MiB in the browser. Native thread configuration applies per video
encoder, so the three-quality ladder uses more CPU than the legacy rendition.
The worker still processes one job at a time under the documented container limits.

At aligned segment boundaries FFmpeg can open new PUTs while previous storage
writes are completing. The private bridge processes at most eight requests and
pauses at most sixteen additional requests, releasing them in arrival order.
It cancels queued requests on disconnect/abort. This preserves bounded processing
and object-size limits without dropping valid segment writes during ordinary
bursts. An incomplete output inventory always prevents publication.

Continue using [ingestion setup](VIDEO_INGESTION.md) and
[playback/CDN setup](VIDEO_PLAYBACK.md). Neither default-off flag is enabled by
this implementation. Lifecycle/recovery work is next in Phase 5; production
capacity and security qualification are later gates.
