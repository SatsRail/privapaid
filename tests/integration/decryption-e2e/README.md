# Decryption end-to-end specs

These specs verify that paid content actually decrypts after a successful
Lightning payment. They exist because once was enough: a real customer paid
$0.01 and saw "Payment received, couldn't unlock the content on this device"
instead of the photo they bought. That kind of failure must be impossible.

Every file here pins one slice of the contract from encryption to display.
If decryption ever breaks again, one of these files should fail before the
customer notices.

## Files

| File | What it pins | When to extend |
|---|---|---|
| `server-client-contract.test.ts` | The crypto primitives (`encryptSourceUrl`, `encryptBytes`) round-trip with the browser-side Web Crypto mirror. Includes the photo envelope (DEK wrap), large bodies, AAD binding, and cross-product isolation. | When you change anything in `src/lib/content-encryption.ts` or `src/lib/client-crypto.ts`. |
| `unlock-endpoint-decrypt.test.ts` | The full `/api/media/[id]/unlock` route — real Postgres, real `encryptSourceUrl`, real Web Crypto on the other side. Includes a key-rotation test. | When you change the unlock route, the access gate, the macaroon verify proxy, or the `MediaProduct` / `ChannelProduct` shape. |
| `admin-upload-decrypt-flow.test.ts` | The admin upload pipeline — real `/api/admin/photos`, `/api/admin/media`, `/api/admin/media/[id]/create-product` — produces data that decrypts cleanly with the portal key that wrapped it. The "fake key" is the test's fixed SatsRail product key. | When you change any admin upload or create-product route, the EncryptedPhotoBlob table, the DEK envelope, or the fingerprint contract. |
| `macaroon-storage-roundtrip.test.ts` | The macaroon cookie storage contract — POST stores, PUT retrieves, DELETE removes, additive across products. | When you change `/api/macaroons/route.ts`, `macaroon-cookie.ts`, or the cookie format. |
| `sentry-init-contract.test.ts` | `sentry.client.config.ts` and `sentry.server.config.ts` correctly enable/disable based on env var presence. | When you change either config file. |

## Companion specs (outside this directory)

| File | What it pins |
|---|---|
| `tests/unit/components/PaymentWall.real-crypto.test.tsx` | The React component runs the real crypto path end-to-end — paid → decrypt → bytes reach `ContentRenderer`. Covers post-payment AND page-reload-via-stored-macaroon for both article and photo. |
| `tests/unit/components/PaymentWall.test.tsx` | All other PaymentWall branches with crypto MOCKED — fast, exhaustive coverage of failure-state UI and Sentry instrumentation. |
| `tests/integration/pages/viewer-photo-page.test.ts` | The viewer page query MUST return `source_url` for photo media. Regression guard for the `.select("-source_url")` bug. |

## Shared helpers

- `tests/helpers/crypto.ts` — `clientDecryptBlob`, `clientDecryptBytesWithKey`,
  `genProductKey`, `sha256HexOfString`, `base64urlToBytes`, `bytesToBase64url`.
  ALL test files in this directory use these. If the client crypto contract
  drifts, this file is the single point of update.
- `tests/helpers/postgres.ts` — `setupTestDB`, `teardownTestDB`,
  `clearCollections`. Isolated Postgres for hermetic runs.
- `tests/helpers/factories.ts` — `createChannel`, `createMedia`,
  `createCustomer`. Minimal Prisma record factories.

## Pre-deploy verification

Beyond Vitest, two more checks belong in any production deploy pipeline:

1. **Bundle-level Sentry DSN inlining.**
   `bash scripts/verify-sentry-dsn-inlined.sh` runs a real `next build`
   with a marker DSN and confirms the marker reaches the client bundle.
   Catches the case where the build env doesn't carry `NEXT_PUBLIC_SENTRY_DSN`
   and the production app ships with Sentry silently disabled.

2. **Live $0.01 payment.**
   No spec can verify the live SatsRail portal's response shape or
   browser-specific Web Crypto edge cases. After deploy, pay $0.01
   for a fresh upload of each media type and confirm the content renders.

## What this directory does NOT cover

- The decryption-blob storage layer in Postgres (covered by `tests/integration/api/admin-*.test.ts`).
- The portal's Ruby side of the contract (covered in `portal/spec/`).
- Browser-specific behavior of `crypto.subtle` (no spec can; covered by
  the manual live-payment step above).
- The deploy script itself (`scripts/deploy-demo.sh` — no spec; ad-hoc).

## Adding a new spec

1. Decide which file above matches your scenario; if none do, add a new
   file in this directory and update the table.
2. Import shared helpers from `../../helpers/crypto` — do NOT redefine
   `clientDecryptBlob` or friends. One source of truth.
3. Use a real `encryptSourceUrl` / `encryptBytes` on the server side
   and the helper's `clientDecryptBlob` / `clientDecryptBytesWithKey`
   on the verification side. If a contract changes, this approach makes
   the failure obvious.
4. If your scenario involves the React component, prefer extending
   `PaymentWall.real-crypto.test.tsx`. If it's pure crypto or HTTP,
   it belongs here.
