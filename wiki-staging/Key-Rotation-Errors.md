# Key Rotation Errors

Product key rotation is admin-triggered from the Stream UI and runs as a streaming re-encryption job. When it fails, content stays decryptable by existing buyers (their macaroons still work), but you'll see an error banner in admin and a partial state in the DB.

## How rotation works (one paragraph)

The admin clicks "Rotate Key" on a product. SatsRail moves the current key to `old_key` and mints a new key. The product enters "rotation pending" state. PrivaPaid's `POST /api/admin/products/:id/re-encrypt` endpoint then iterates every `MediaEncryptedBlob` row covered by the product: it sources plaintext locally from `Media.blob` (URL string or `CONTENT_KEK`-wrapped DEK depending on media type), encrypts under the new product key with AAD = the SatsRail product UUID, and updates the row. On clean completion it calls SatsRail's `clear_old_key` API. Progress streams back to the admin as newline-delimited JSON.

The critical design choice: PrivaPaid **does not** decrypt with `old_key` to source plaintext. Local plaintext recovery (`Media.blob.url` or `CONTENT_KEK`-unwrapped DEK) is the source of truth. That makes rotation robust to SatsRail returning the wrong `old_key`, network blips, and partial re-encryption recovery.

## Failure modes

### Re-encryption stops partway through

Symptoms: admin sees `errors > 0` in the streaming progress; some `MediaEncryptedBlob` rows have the new ciphertext, others still have the old. Existing buyers see decryption failures on the rows that didn't re-encrypt yet.

**Cause:** transient error (DB timeout, OOM, network) mid-stream.

**Fix:** click "Re-encrypt" again. The flow is idempotent — each row's `encryptedSource` is overwritten with new ciphertext bound to the new product key. Already-re-encrypted rows just get re-overwritten (no harm, mild waste). Continue until `errors === 0` in the response stream.

### Media not found

Symptoms: progress JSON includes `errors: 1+` with messages like `Media <id> not found — was it deleted?`.

**Cause:** a media row was deleted between when the product was created and when rotation ran. The `MediaEncryptedBlob` row still references the deleted media.

**Fix:** clean up the orphan blob:

```sql
DELETE FROM "MediaEncryptedBlob"
WHERE "mediaId" NOT IN (SELECT id FROM "Media");
```

Then re-run rotation.

### `CONTENT_KEK` missing or wrong (envelope kinds)

Symptoms: rotation succeeds for url-backed media (video, audio, podcast) but fails for envelope-encrypted media (photo, article) with errors like `Failed to unwrap article DEK: ...` or `CONTENT_KEK is not set`.

**Cause:** the `CONTENT_KEK` env var isn't set, or doesn't match the KEK that wrapped the original DEK.

**Fix:** see [[Missing CONTENT_KEK]]. If the original KEK is lost, those envelope rows are not rotatable. Existing buyers retain access until their macaroon expires. New product purchases over the affected media will fail (the rotation flow is needed to wrap the DEK under the new key).

### SatsRail returns 5xx mid-rotation

Symptoms: progress stops, `errors > 0`, the SatsRail API call to fetch the new key or clear the old one failed.

**Cause:** SatsRail temporarily unavailable.

**Fix:** retry. The rotation flow is designed for this — clicking "Re-encrypt" again resumes from where it stopped. SatsRail's `old_key` stays in place until PrivaPaid explicitly clears it on a clean run.

### Rotation banner stuck after success

Symptoms: re-encryption completed with `errors === 0`, but the admin UI still shows "Rotation Pending".

**Cause:** the final `clear_old_key` call to SatsRail failed (network blip after re-encryption completed).

**Fix:** click "Re-encrypt" again. The flow detects that all rows are already re-encrypted (idempotent), and retries the `clear_old_key` call. Once SatsRail confirms, the banner clears.

If repeated retries don't clear it, manually clear via SatsRail's merchant API:

```bash
curl -X POST https://satsrail.com/api/v1/m/products/<product_id>/clear-old-key \
  -H "Authorization: Bearer sk_live_..."
```

Then refresh the admin UI.

## When NOT to rotate

- **Mid-deploy** — finish the deploy first, then rotate. Mixing deploy-time `prisma migrate deploy` with rotation traffic risks deadlocks.
- **Without `CONTENT_KEK` configured** — envelope-encrypted media will fail. Either set the KEK first or accept the partial rotation (url-backed media only).
- **During a known SatsRail incident** — wait for status.satsrail.com to clear.

## Pre-rotation checklist

- [ ] Postgres backup ([[Backups and Restore]])
- [ ] All three keys backed up off-platform
- [ ] `CONTENT_KEK` confirmed set if you have any photo or article media
- [ ] No deploys in progress
- [ ] Maintenance window scheduled for the re-encryption duration (typically 1–5 seconds per blob)

## Architecture reference

For the full encryption design and why rotation works this way (local plaintext recovery, why we don't depend on `old_key`, per-product DEK wrapping), see [`docs/ENCRYPTION.md`](https://github.com/SatsRail/privapaid/blob/main/docs/ENCRYPTION.md).

## See also

- [[Missing CONTENT_KEK]] — recovery options if the KEK is lost
- [[Backups and Restore]] — pre-rotation backup procedure
- [[Healthcheck Failures]] — diagnosing if rotation triggers a healthcheck regression
