-- Optional overrides preserve existing themes. No data rewrite is needed.
ALTER TABLE "Settings"
  ADD COLUMN "themePrimaryText" TEXT,
  ADD COLUMN "themeLink" TEXT,
  ADD COLUMN "themeNavBg" TEXT,
  ADD COLUMN "themeNavText" TEXT,
  ADD COLUMN "themeHover" TEXT,
  ADD COLUMN "themeMediaBg" TEXT,
  ADD COLUMN "themeMediaText" TEXT,
  ADD COLUMN "themeSuccess" TEXT,
  ADD COLUMN "themeWarning" TEXT,
  ADD COLUMN "themeError" TEXT;
