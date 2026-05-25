#!/bin/sh
set -e

DATA_DIR="/app/data"
GENERATED_ENV="$DATA_DIR/.generated-env"

mkdir -p "$DATA_DIR"

# Refuse to auto-generate secrets onto ephemeral storage. tmpfs/overlay
# means the .generated-env file vanishes on restart, which silently rotates
# SK_ENCRYPTION_KEY — that key is the ONLY thing protecting the merchant's
# sk_live_ key in the database. Losing it bricks every encrypted record.
#
# Operators on Railway or any platform with ephemeral container filesystems
# must set NEXTAUTH_SECRET and SK_ENCRYPTION_KEY explicitly in env. See
# README "Important" callout under the Railway section.
detect_ephemeral_fs() {
  fs_type=$(stat -f -c %T "$DATA_DIR" 2>/dev/null || echo "")
  if [ -z "$fs_type" ] && [ -r /proc/mounts ]; then
    fs_type=$(awk -v d="$DATA_DIR" '$2 == d { print $3 }' /proc/mounts | head -n1)
  fi
  case "$fs_type" in
    tmpfs|overlay|overlayfs)
      return 0
      ;;
  esac
  return 1
}

# Load previously generated secrets if they exist
if [ -f "$GENERATED_ENV" ]; then
  . "$GENERATED_ENV"
  AUTH_SECRET="${AUTH_SECRET:-$NEXTAUTH_SECRET}"
  export NEXTAUTH_SECRET AUTH_SECRET SK_ENCRYPTION_KEY
fi

if [ -z "$NEXTAUTH_SECRET" ] || [ -z "$SK_ENCRYPTION_KEY" ]; then
  if detect_ephemeral_fs; then
    echo "ERROR: $DATA_DIR is on ephemeral storage (tmpfs/overlay)." >&2
    echo "       Auto-generating secrets here would lose them on restart and" >&2
    echo "       brick every encrypted record in Postgres." >&2
    echo "       Set NEXTAUTH_SECRET and SK_ENCRYPTION_KEY explicitly in env," >&2
    echo "       or mount a persistent volume at $DATA_DIR." >&2
    exit 1
  fi
fi

# Generate NEXTAUTH_SECRET if not set
if [ -z "$NEXTAUTH_SECRET" ]; then
  NEXTAUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  echo "NEXTAUTH_SECRET=$NEXTAUTH_SECRET" >> "$GENERATED_ENV"
  export NEXTAUTH_SECRET
  AUTH_SECRET="$NEXTAUTH_SECRET"
  export AUTH_SECRET
  echo "Generated NEXTAUTH_SECRET — back up $GENERATED_ENV"
fi

# Generate SK_ENCRYPTION_KEY if not set
if [ -z "$SK_ENCRYPTION_KEY" ]; then
  SK_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "SK_ENCRYPTION_KEY=$SK_ENCRYPTION_KEY" >> "$GENERATED_ENV"
  export SK_ENCRYPTION_KEY
  echo "Generated SK_ENCRYPTION_KEY — back up $GENERATED_ENV NOW. Losing this"
  echo "  key means losing access to every encrypted merchant key in Postgres."
fi

# Lock down the generated-env file so it isn't world-readable.
if [ -f "$GENERATED_ENV" ]; then
  chmod 600 "$GENERATED_ENV" 2>/dev/null || true
fi

# Apply pending Prisma migrations before starting the server. Idempotent —
# `migrate deploy` is the production-safe variant (no schema drift checks,
# no prompts). Fails fast if DATABASE_URL is missing or unreachable.
if [ -n "$DATABASE_URL" ]; then
  npx prisma migrate deploy
fi

exec "$@"
