# Missing `CONTENT_KEK`

`CONTENT_KEK` is the operator-held key encryption key that wraps every per-content DEK on `Media.blob.encryptedDek` for photos and articles. Lose it or fail to set it and PrivaPaid loses operator-side rotation and admin preview for envelope-encrypted content.

## Symptoms

### On a fresh deploy (key never existed)

- **Railway / ephemeral fs:** entrypoint exits 1 at startup with an explicit error:
  ```
  ERROR: /app/data is on ephemeral storage (tmpfs/overlay).
         Auto-generating secrets here would lose them on restart and
         brick every encrypted record in Postgres.
         Set NEXTAUTH_SECRET, SK_ENCRYPTION_KEY, and CONTENT_KEK
         explicitly in env, or mount a persistent volume at /app/data.
  ```
- **EC2 / Docker compose with persistent volume:** entrypoint auto-generates and writes to `/app/data/.generated-env`. Operator must back this file up.

### On an upgrade from `PHOTO_KEK`

Older versions used `PHOTO_KEK`. The new code reads `CONTENT_KEK` only. If you upgraded without renaming:

- The app boots successfully (the KEK is lazily loaded on first wrap/unwrap call)
- Creating a new photo or article fails with HTTP 422: `Failed to KEK-wrap article DEK: CONTENT_KEK is not set. Generate one with openssl rand -base64 32...`
- Admin preview of an existing article returns 500 with `Failed to decrypt content — check CONTENT_KEK configuration`

**Fix:** rename `PHOTO_KEK=<value>` → `CONTENT_KEK=<value>` in your env/Variables. Same value, no rotation. The old name is no longer read.

### Existing content stops decrypting

If you actually lost the value (volume wiped, secrets store purged), here's what's recoverable:

| Operation | Still works? |
|---|---|
| Existing paid viewers using their macaroon + already-fetched product key | Yes — they have everything they need on the client |
| New buyers paying for existing content | Yes — the per-product blob doesn't depend on CONTENT_KEK; only the operator-side recovery path does |
| Creating a new product over existing envelope content | **No** — requires unwrapping the DEK |
| Key rotation on envelope-encrypted media | **No** — rotation reads the wrapped DEK |
| Admin preview of envelope content | **No** — preview decrypts using the wrapped DEK |
| Creating new photos / articles | Yes — new content gets a fresh DEK wrapped with the new KEK |

## Recovery from a lost `CONTENT_KEK`

There is no cryptographic recovery. The wrapped DEK on `Media.blob.encryptedDek` is decryptable only with the original KEK.

If you have a recent Postgres backup taken before the KEK was lost, restore that and use the matching KEK. Otherwise:

1. **Generate a new `CONTENT_KEK`** with `openssl rand -base64 32`
2. **Set it** in env / Variables
3. **Accept the loss of operator-side recovery for old content.** New content created from this point on will wrap under the new KEK and is fully recoverable.
4. **Document the cutoff date.** Any old envelope content can still be sold (per-product blobs still decrypt) but you can't add new products to old content or rotate its key.

## Backup procedure to prevent recurrence

See [[Operator Playbook]] § "Backup procedure". TL;DR:

- **Password manager** entry titled "PrivaPaid production CONTENT_KEK" with the value
- **Printed paper backup** in a physical safe (the same one you'd use for a Bitcoin seed phrase)
- **Cloud secrets manager** (AWS Secrets Manager, 1Password, etc.) with audit logging enabled
- **`.generated-env`** file backed up if you let the entrypoint auto-generate

This key has the same threat model as `SK_ENCRYPTION_KEY` — treat it with the same care.

## See also

- [[Operator Playbook]] — full key backup procedure
- [[Deploy on Railway]] — `${{secret(32, "base64")}}` template variable to auto-generate
- [Architecture (docs/ENCRYPTION.md)](https://github.com/SatsRail/privapaid/blob/main/docs/ENCRYPTION.md) — envelope encryption design
