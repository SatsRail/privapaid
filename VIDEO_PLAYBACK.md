# Encrypted video playback (Phase 3)

Phase 3 is implemented and tested locally. `VIDEO_PLAYBACK_ENABLED=false` keeps
it off. Live CloudFront delivery, a full-length movie through a real purchase,
physical-device qualification and production capacity remain release gates.
Phase 4 adds [adaptive quality and creator controls](VIDEO_ADAPTIVE.md).
See [the execution plan](ENCRYPTED_VIDEO_PLAN.md) and [evidence](plans/video/evidence/phase-3.md).

## Request flow

1. The existing checkout stores the payment macaroon in the storefront's host-only,
   httpOnly cookie. A return visit makes one initial playback-session request;
   it does not also call the legacy unlock endpoint.
2. `POST /api/media/:id/playback-session` verifies locally associated products via
   the existing access gate. SatsRail receives only the macaroon. It checks the
   signed token, merchant, product, paid order, covering line item and entitlement.
3. PrivaPaid rechecks local media/channel/version availability and the current
   wrapped media key. It returns the product key/fingerprint, wrapped media DEK,
   encrypted immutable descriptor and a short-lived delivery grant. No root key
   is unwrapped on the web server. Key-bearing responses are `private, no-store`.
4. The browser posts that signed grant to the **media hostname's**
   `/api/video-delivery/grant`. That endpoint verifies the RSA signature, exact
   resource scope and deadline before setting CloudFront cookies. It does not
   accept a payment token or merchant credential.
5. Shaka requests the encrypted catalog, manifest and segments directly from the
   media hostname. Web Crypto verifies the key fingerprint, unwraps the key chain,
   authenticates each PPV1 object and checks its inventory hash/length before
   returning plaintext to one continuous MediaSource player.

The database stores bounded descriptors/references and wrapped keys. Movie bytes
remain in object storage. All viewers of one immutable version fetch the same
ciphertext; granting another viewer does not copy or re-encrypt the movie.

The player uses a private networking scheme per instance, a fixed manifest URL
subset and catalog allowlisting. It rejects source objects, arbitrary URLs,
redirects, externally hosted manifest dependencies, corrupt objects and identity
substitution. Fetch/decrypt concurrency is two, maximum encrypted object size is
32 MiB + 32 bytes, catalog size is capped at 4 MiB, buffer goal is 12 seconds and
buffer-behind target is 8 seconds. Segment boundaries can overshoot buffer targets.
The Chrome fixture's maximum buffered span was 24 seconds. Long-film process and
browser memory still need measurement; these limits are not a measured RAM budget.

No service-worker fetch handler, offline cache, localStorage, IndexedDB or download
feature is introduced. Root keys are imported as non-extractable CryptoKeys and
used only in memory. Temporary byte arrays are cleared where owned; JS strings,
garbage collection and browser media buffers cannot be guaranteed to erase
immediately. Teardown aborts requests, cancels renewal, destroys Shaka, drops key
references and detaches the media source.

## SatsRail expiry prerequisite

Deploy the additive verification change before enabling playback. Successful
product-bound `/m/access/verify` and `/pub/access/verify` responses now contain:

```json
{"valid":true,"remaining_seconds":7,"server_time":1800000000,"expires_at":1800000007}
```

These fields accompany the existing product/key fields. `remaining_seconds` is
bounded by **both** signed-token expiry and current paid entitlement. Times are
Unix seconds, anchored before verification's database work. Legacy resource
responses are unchanged. PrivaPaid keeps legacy content compatible with older
SatsRail responses, but video session creation refuses missing/inconsistent
bounds with `503 ACCESS_BOUNDS_REQUIRED` (or `ACCESS_UNAVAILABLE` for malformed
responses). It never guesses entitlement from the product's advertised duration.

PrivaPaid anchors the remote TTL at verification request start, allowing for
monotonic round-trip time, subtracts two seconds and rounds down. A grant expires
at the earlier of that deadline or `VIDEO_DELIVERY_TTL_SECONDS` (default/max 300).
The browser anchors its deadline at session request start and subtracts another
second. Keep SatsRail, PrivaPaid and CDN clocks synchronized; the two-second
allowance is not protection from an arbitrarily incorrect host clock.

## First-party delivery deployment

The production adapter is AWS S3 + CloudFront. The local delivery route exists
only for development and explicitly rejects production use. S3-compatible
storage remains supported by ingestion; another production CDN needs its own
qualified delivery adapter.

Use two distinct HTTPS hostnames in the same registrable domain, for example
`watch.example.com` and `media.example.com`. Two ports on one hostname do **not**
isolate cookies. Public-suffix and private-suffix checks reject unrelated sites,
including separate `github.io` tenants. An external storefront embed would make
this cookie design third-party; playback is currently qualified only when the
viewer opens the storefront as a first-party site.

[CloudFormation template](examples/video/cloudfront/template.json) creates:

- A retained private bucket with public-access blocks, TLS enforcement, SSE-S3
  and incomplete-multipart cleanup. SSE-S3 is additional to PPV1 client encryption.
- CloudFront OAC with bucket read permission only for output attempt paths;
  source staging is outside that permission.
- A trusted public-key group on the default ciphertext behavior. Viewer signature
  checks apply even when the ciphertext is already cached. The cache key excludes
  cookies, query strings and headers so authorized viewers share cached objects.
- Exact credentialed CORS for the storefront and an uncached grant behavior
  forwarded to its application origin. Payment cookies and authorization headers
  are not forwarded. Application code accepts only POST/OPTIONS on this path.
- A workload IAM policy to attach to the ingestion/app role, without creating
  permanent access keys. The role is privileged and can read encrypted sources.

Supply a public RSA-2048 key, sibling hostnames, a certificate covering the media
hostname in ACM `us-east-1`, and optionally a Route 53 zone. The stack is not
created by this repository. Generate and protect the private key in the operator's
secret manager; only PrivaPaid needs it. Use the stack's key-pair ID, bucket, region
and prefix outputs for runtime settings:

```dotenv
VIDEO_PIPELINE_ENABLED=true
VIDEO_PLAYBACK_ENABLED=false
VIDEO_STORAGE_PROVIDER=s3
VIDEO_S3_BUCKET=<stack bucket>
VIDEO_S3_REGION=<stack region>
VIDEO_S3_PREFIX=privapaid-video/
VIDEO_DELIVERY_PROVIDER=cloudfront
AUTH_URL=https://watch.example.com
VIDEO_MEDIA_ORIGIN=https://media.example.com
VIDEO_CLOUDFRONT_KEY_PAIR_ID=<stack public key ID>
VIDEO_DELIVERY_TTL_SECONDS=300
# VIDEO_DELIVERY_PRIVATE_KEY: complete PEM from secret configuration
```

Use the regular AWS workload credential chain. Leave `VIDEO_S3_ENDPOINT` unset
and path-style access off for this adapter. Configure storage **before ingesting**:
versions pin the storage identity; changing providers does not migrate old data.
Serve the media hostname only through CloudFront. Forward its grant path to the
same PrivaPaid deployment and prevent proxy/access logging of response bodies,
Cookie, Authorization, signatures and private keys. Disable CloudFront cookie
logging. Verify both successful and failed CORS responses on the live distribution.

Four host-only, httpOnly, Secure, SameSite=Lax cookies carry the custom policy,
signature, key-pair ID and SHA256 algorithm. Each cookie's Path is the exact
immutable asset/version/attempt directory. Two movies therefore coexist; neither
cookie scope authorizes the other. The test uses actual HTTPS sibling hostnames,
real browser cookies and no CORS bypass or request interception.

The adapter follows AWS's [custom signed-cookie policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-setting-signed-cookie-custom-policy.html)
and Shaka's [networking plugin contract](https://shaka-project.github.io/shaka-player/docs/api/tutorial-plugins.html).

Validate the template with `cfn-lint examples/video/cloudfront/template.json`.
Run the live origin/cache/expiry and full-film gates before changing
`VIDEO_PLAYBACK_ENABLED` to true. This change neither provisions nor deploys AWS.
Rollback disables this flag; previously issued grants survive only to their
original deadline. Existing legacy content delivery remains available.

## Renewal and revocation

One player owns one renewal timer and one deduplicated in-flight renewal. It
renews at a randomized 65–80% of the remaining grant lifetime. Segment duration
never determines SatsRail call frequency. The existing access gate verifies each
present covering product token; multiple applicable paid products can therefore
cause multiple SatsRail checks per renewal. Include that in capacity budgets.

Renewal pins the immutable version, repeats paid verification and local checks,
and replaces cookies only after success. 429/5xx/network failures retain the last
valid grant, respect Retry-After and use jittered exponential backoff. They never
extend a grant, erase a payment or initiate another checkout. At the known deadline
new object fetches stop until verification succeeds; playback can resume after
recovery. An explicit retry preserves version and playhead. Definitive denial
stops renewal. Local deleted/error media, disabled/deleted channels and deleted
versions cannot start/renew. Archiving a product stops sales; it does not revoke
an already valid payment.

Revocation is renewal-based: already issued CDN credentials can remain usable for
at most the configured grant TTL (up to five minutes) after a state change. An
object request admitted before expiry can finish afterwards; browser fetches time
out after 30 seconds. Already decrypted/recorded media cannot be revoked. This is
payment-gated encrypted delivery, not hardware-backed studio DRM or a guarantee
against copying by an authorized viewer. Retain playing immutable versions until
the Phase 5 lifecycle policy can safely retire them.

## Local verification

Requires Node 22+, FFmpeg, PostgreSQL for integration tests and Chrome for the
opt-in browser proof. Use a disposable explicit `DATABASE_URL` and
`TEST_DATABASE_URL`; test helpers truncate tables.

```sh
npm run test:video-foundations
VIDEO_BROWSER_TEST=true npm run test:video-playback
npm run typecheck
```

The browser test generates synthetic media and temporary TLS keys, starts a
loopback HTTPS server, resolves only its test hostnames to loopback in Chrome,
and removes its temporary files. It exercises production player code and real
local delivery/grant handlers. Its paid session is a contract fixture; separate
integration tests exercise the actual session route/access gate, and SatsRail
request specs exercise payment/token verification. This is not a completed live
purchase/CDN or full-film test. `VIDEO_BROWSER_REPORT=<path>` saves key-free metrics.
