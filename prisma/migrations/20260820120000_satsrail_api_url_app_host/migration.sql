-- satsrail.com stopped resolving when the portal moved to Railway: it has no A
-- record and no CNAME, so it is not a redirect, it is a DNS failure. Every
-- Settings row still pointing at it cannot reach the payment API at all —
-- checkout, key delivery, and payment verification all fail.
--
-- app.satsrail.com is the host for programmatic access (www.satsrail.com is the
-- marketing site and the merchant dashboard). Change the default so new
-- installs are correct, and rewrite the rows that are already broken.
ALTER TABLE "Settings"
  ALTER COLUMN "satsrailApiUrl" SET DEFAULT 'https://app.satsrail.com/api/v1';

-- Swap the host and keep whatever path the operator configured, so a custom
-- "https://satsrail.com/api/v2" becomes "https://app.satsrail.com/api/v2"
-- rather than being flattened back to the default.
--
-- Deliberately narrow: rows on www.satsrail.com are left alone. That host
-- resolves and works; an operator who typed it meant it. Only the dead apex is
-- rewritten. The trailing-slash guard keeps this from matching a lookalike
-- domain such as "https://satsrail.community/api".
UPDATE "Settings"
SET "satsrailApiUrl" =
      'https://app.satsrail.com' ||
      substring("satsrailApiUrl" FROM length('https://satsrail.com') + 1)
WHERE "satsrailApiUrl" = 'https://satsrail.com'
   OR "satsrailApiUrl" LIKE 'https://satsrail.com/%';
