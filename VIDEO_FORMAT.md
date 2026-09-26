# Experimental segmented-video formats

Phase 2 ingestion writes **PPV1**, specified below. The original PPV0 synthetic
proof is retained verbatim after that specification for reproducibility. Neither
format has completed the production device/security qualification gates.

## PPV1: Phase 2 ingestion format

Implementation: `src/lib/video/format.ts`, `package-job.ts`, `validation.ts`.
PPV1 is application-layer AES-256-GCM over separate-track DASH/fMP4. It is not
DASH CENC/DRM or native HLS. The Phase 0 Shaka proof still reads PPV0; Phase 3
implements PPV1 explicitly; the two formats are not interchangeable. Phase 4
adds multiple video representations without changing PPV1 encryption or key
derivation. The browser accepts up to 15,000 inventory entries in a catalog
bounded to 4 MiB.

Each immutable version has a fresh random 32-byte movie root, wrapped for operator
recovery by the existing `CONTENT_KEK` mechanism. Object identity contains
lowercase UUID strings `asset`, `version`, `attempt` plus an allowlisted `name`:

- Output: `play.mpd`, `catalog.json`, `init-{track}.mp4`, or
  `segment-{track}-{sequence}.m4s` (track 1–3 digits, sequence 5–8 digits).
- Source: `source-{index}.bin` (six decimal digits, starting at zero).
- Output attempt is the job's random lease UUID; source attempt is the upload
  session UUID. This separates source, retries, versions, tracks and sequences.

The exact UTF-8 compact JSON authentication context is:

```text
["privapaid-video",1,"<asset>","<version>","<attempt>","<name>"]
```

Derive 32 bytes with HKDF-SHA-256: IKM = movie root, salt = UTF-8 version UUID,
info = the context above. Encrypt 1 byte through 32 MiB with AES-256-GCM using
a fresh random 12-byte IV, the same context as AAD, and a 16-byte tag. Stored
layout: `ASCII PPV1[4] || IV[12] || ciphertext[N] || tag[16]`. Authenticate before
returning any plaintext; wrong magic, identity, size or tag fails closed. Each
object write is immutable. Retried source parts compare authenticated content;
processing retries use a new attempt namespace and newly derived object keys.

Storage layout beneath the adapter's private root/bucket prefix:

```text
assets/<asset>/versions/<version>/source/source-000000.bin
assets/<asset>/versions/<version>/attempts/<lease>/init-0.mp4
assets/<asset>/versions/<version>/attempts/<lease>/segment-0-00001.m4s
assets/<asset>/versions/<version>/attempts/<lease>/play.mpd
assets/<asset>/versions/<version>/attempts/<lease>/catalog.json
```

The final encrypted catalog is JSON `{format:1,asset,version,attempt,objects}`.
Each entry has `{name,bytes,encryptedBytes,sha256,encryptedSha256}`, sorted by
name. It covers all init/media objects and `play.mpd`, excluding itself. Hashes
are lowercase SHA-256 hex. The final manifest has relative allowlisted names;
external URLs/BaseURL/Location/entities are forbidden. Both catalog and manifest
are encrypted only after media integrity and complete timeline validation.

`VideoAssetVersion.encryptedDescriptor` uses the existing **media DEK**, not a
stored SatsRail product key. It contains compact JSON:

```text
{format:1,asset,version,attempt,rootKey,prefix,
 manifest:{name:"play.mpd",sha256:<encrypted hash>},
 catalog:{name:"catalog.json",sha256:<encrypted hash>}}
```

`rootKey` is unpadded base64url of the random movie root. Descriptor plaintext is
at most 16,000 bytes. Encrypt with AES-256-GCM, fresh 12-byte random IV and AAD
UTF-8 compact JSON `["privapaid-video-descriptor",1,"<asset>","<version>"]`.
Descriptor bytes are `IV[12] || ciphertext || tag[16]` (no PPV object header).
It is committed with readiness/publication in one database transaction.

The access chain is product key → existing `MediaProduct.encryptedDek` → media
DEK → this encrypted descriptor → movie root → object keys. Existing
`MediaEnvelope.bytes` remains unchanged until Phase 3 selects this descriptor in
the paid playback contract. Multiple buyers/products use the same ciphertext.
Product rotation rewraps the media DEK; replacing a compromised movie root needs
a new encrypted version. A paying device can retain keys/plaintext.

Tests include independent Web Crypto decryption of each object type and identity
substitution/corruption rejection. Source transport parts are 8 MiB; playback
segments are 4 or 10 seconds and may end with a shorter segment. These are
independent boundaries. No macaroon or per-segment remote key is encoded here.

## PPV0: original synthetic proof

Status: Phase 0 proof, 2026-09-26. **Not a production format or an access-control
implementation.** The experiment lives in [tools/video-proof](tools/video-proof/README.md)
and is not imported by the application. Production uses fresh random secret keys;
the synthetic fixture intentionally uses a publicly reproducible test key.

## Packaging and player decision

The first candidate uses DASH manifests with separate H.264 video and AAC audio
tracks, fMP4 init objects and independently encrypted media fragments. FFmpeg
produces both tracks from one continuous source timeline. Candidate segment
durations are 4 and 10 seconds; the last segment can be shorter. Audio packet
boundaries need not land on precisely the same fractional timestamp as video.

Shaka Player **5.2.12** handles manifest parsing, scheduling, buffering and seeking.
An asynchronous networking response filter authenticates/decrypts manifests,
initialization and media objects before passing bytes to Shaka. We use a maintained
player without implementing a new media-buffer scheduler or forking Shaka.

This is application-layer encryption over DASH, not DASH Common Encryption/DRM
or a native-HLS-compatible ciphertext format. Shaka's documented HLS AES-256-GCM
path uses a different layout (16-byte IV) and lacks the AAD needed by this
candidate. The adapter allows explicit object binding with a 12-byte IV.
Native HLS fallback must not bypass it. Browser/device qualification remains open.
References: [Shaka segment decryptor](https://shaka-project.github.io/shaka-player/docs/api/lib_media_segment_utils.js.html),
[Shaka networking filters](https://shaka-project.github.io/shaka-player/docs/api/shaka.net.NetworkingEngine.html),
[MSE fMP4 structure](https://www.w3.org/TR/mse-byte-stream-format-isobmff/).

## Object identity and bytes

Each fixture has two lowercase UUIDv4 identifiers: asset and immutable version.
Allowed object names in this proof are exactly:

- `play.mpd` — the final manifest.
- `init-{track}.mp4` — track IDs of one to three decimal digits.
- `segment-{track}-{sequence}.m4s` — sequence is five to eight decimal digits.

Names contain no directory components, query strings or remote URLs. The complete
identity, including track/sequence as encoded in the name, is authenticated. A
production object layout can be different only under a new format specification.

The authentication context is UTF-8 encoding of this exact compact JSON array:

```text
["privapaid-video-proof",0,"<asset UUID>","<version UUID>","<object name>"]
```

Derive an object key with HKDF-SHA-256:

```text
input key material = 32-byte movie root key
salt               = UTF-8(version UUID)
info               = authentication context above
output length      = 32 bytes
```

Use AES-256-GCM with the derived object key, a fresh cryptographically random
12-byte IV, the authentication context as additional authenticated data, and a
128-bit authentication tag. Stored bytes are:

```text
offset  length   content
0       4        ASCII PPV0
4       12       IV
16      N        ciphertext
16+N    16       authentication tag
```

The context's fixed format/version identifies the header, and the decoder rejects
any unsupported magic. The proof accepts 1 byte through 32 MiB of plaintext per
object. Decryption returns no bytes until tag verification succeeds. Corruption,
wrong asset/version/key, swapped tracks/sequences, and manifest/init substitution
must fail before parsing or decoding.

Each encryption call uses a fresh IV; each object has a separately derived key.
Generation refuses an existing output directory, allocates fresh asset/version
IDs, and writes every object with exclusive creation. FFmpeg's provisional
manifests remain in RAM; only its final manifest is encrypted/persisted after
successful completion. A failed run is unpublished (no `fixture.json` completion
record). Retrying means a new directory/version/key, not reusing partial output.
Random-IV tests detect implementation regressions; they are not a mathematical
proof against all collisions. Production recovery/concurrency still needs Phase 1–2.

## Product key hierarchy for later integration

The proof does **not** connect to SatsRail or change existing envelopes. Proposed
integration preserves this chain:

```text
SatsRail product key
  → existing product-bound MediaProduct.encryptedDek
  → media DEK
  → encrypted MediaEnvelope descriptor for a selected video version
  → fresh movie root key for that version
  → independently derived object keys
```

The encrypted descriptor binds the asset/version, manifest locator and movie root
key. Its exact production schema and recovery wrapping are not implemented here.
Persist the movie root only encrypted, recoverable through the operator's existing
KEK/envelope system. Multiple products wrap the same media DEK independently;
they do not create a different movie ciphertext per buyer/product. Product-key
rotation rewraps access envelopes. A compromised movie key requires a fresh root
and new encrypted movie version, and cannot revoke already retained plaintext.

## Synthetic fixture exception and trust boundary

The fixture root is `SHA-256(UTF-8("privapaid-public-synthetic-fixture-v0:" + version))`.
This is **public test material, not protection for real content**. The generator
accepts only FFmpeg's built-in moving test pattern with its timestamp and a
continuous 440 Hz audio source. It has no input-file or input-URL option.
Never reuse this key scheme, session endpoint or harness for customer uploads.

FFmpeg writes plaintext only to an ephemeral loopback HTTP sink. The sink buffers
at most the capped object size per request and encrypts before writing to disk;
no plaintext MP4 source or segment files are generated. This proves the output
side of processing. Seekable encrypted input, crash/swap hardening and production
worker resource isolation remain unimplemented. Fixture metadata records source
and encrypted SHA-256 checksums plus exact FFmpeg arguments/version.

The playback server binds to `127.0.0.1`, rejects other Host/Origin values and
serves only an allowlist of objects. `/session` supplies public fixture key and
inventory metadata with `no-store`. It has no buyer authentication. In production,
the equivalent descriptor must come from PrivaPaid's authenticated key/session
flow, with short-lived scoped CDN grants and private storage. SatsRail macaroons
never become media keys or CDN signing credentials.

The browser request filter restricts fetches to the trusted fixture inventory.
The response filter checks format, identity, tag and plaintext size before Shaka
receives a manifest or fragment. HKDF key material is imported as a non-extractable
CryptoKey; the temporary byte array is overwritten and no browser storage is used.
These steps reduce accidental persistence, not extraction by a paying device owner.
The response filter sees a fully downloaded object; production must additionally
bound wire bytes, concurrent fetches, retries and aborted decryption work.

## Tests and compatibility status

Tests cover native Node encryption → Web Crypto decryption, independent HKDF and
AES-GCM known answers, identity encoding, corruption/truncation, malformed names,
wrong key/asset/version/track/sequence, and retry IV behavior. The browser harness
also corrupts and substitutes real first video segments and requires failure
before the first decoded frame.

FFprobe validates every audio/video packet in the generated fixtures after
decryption, including continuous timestamps, expected frame/keyframe counts and
final duration. Browser automation measures actual decoding, startup, buffering,
seeking and pause/resume. Packet continuity does not prove absence of perceptible
audio clicks; headless playback does not qualify real phones or Safari.

See [Phase 0 evidence](plans/video/evidence/phase-0.md) for exact outcomes and
remaining gates. This format stays experimental until those gates pass.
