-- Every envelope LINKED to a Media must carry a wrapped DEK — without one the
-- payload is undecryptable and the media renders the "temporarily unavailable"
-- wall. Staged envelopes (mediaId NULL, e.g. photo uploads awaiting their Media
-- row) are exempt; they get linked only after the wrap exists.
--
-- NOT VALID: pre-MediaEnvelope-migration url media may legitimately have a
-- linked envelope with a NULL wrappedDek (their plaintext source was dropped
-- and is only recoverable by re-import / re-saving the URL — see
-- scripts/audit-media-envelopes.ts). Those legacy rows must not block the
-- migration; the check applies to every INSERT/UPDATE from here on, so no NEW
-- broken link can be created.
ALTER TABLE "MediaEnvelope" ADD CONSTRAINT "MediaEnvelope_linked_has_wrappedDek"
  CHECK ("mediaId" IS NULL OR "wrappedDek" IS NOT NULL) NOT VALID;
