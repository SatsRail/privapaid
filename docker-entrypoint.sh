#!/bin/sh
set -e

DATA_DIR="/app/data"
GENERATED_ENV="$DATA_DIR/.generated-env"

mkdir -p "$DATA_DIR"

# Refuse to auto-generate secrets onto ephemeral storage. tmpfs/overlay
# means the .generated-env file vanishes on restart, which silently rotates
# SK_ENCRYPTION_KEY / CONTENT_KEK — those keys are the ONLY thing
# protecting (a) the merchant's sk_live_ key in the database and (b) the
# per-content DEK on every envelope-encrypted Media row. Losing either
# bricks the corresponding ciphertext irrecoverably.
#
# Operators on Railway or any platform with ephemeral container filesystems
# must set NEXTAUTH_SECRET, SK_ENCRYPTION_KEY, and CONTENT_KEK explicitly
# in env. See README "Important" callout under the Railway section.
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
  export NEXTAUTH_SECRET AUTH_SECRET SK_ENCRYPTION_KEY CONTENT_KEK
fi

if [ -z "$NEXTAUTH_SECRET" ] || [ -z "$SK_ENCRYPTION_KEY" ] || [ -z "$CONTENT_KEK" ]; then
  if detect_ephemeral_fs; then
    echo "ERROR: $DATA_DIR is on ephemeral storage (tmpfs/overlay)." >&2
    echo "       Auto-generating secrets here would lose them on restart and" >&2
    echo "       brick every encrypted record in Postgres." >&2
    echo "       Set NEXTAUTH_SECRET, SK_ENCRYPTION_KEY, and CONTENT_KEK"  >&2
    echo "       explicitly in env, or mount a persistent volume at $DATA_DIR." >&2
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

# Generate CONTENT_KEK if not set. Wraps the per-content DEK on
# Media.blob.encryptedDek for photos and articles. Losing this means losing
# the ability to rotate product keys, admin-preview, or admin-edit
# envelope-encrypted content (the ciphertext itself stays decryptable to
# anyone who already paid, but operator-side recovery is gone).
if [ -z "$CONTENT_KEK" ]; then
  CONTENT_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  echo "CONTENT_KEK=$CONTENT_KEK" >> "$GENERATED_ENV"
  export CONTENT_KEK
  echo "Generated CONTENT_KEK — back up $GENERATED_ENV NOW. Losing this"
  echo "  key means losing the ability to rotate or admin-preview every"
  echo "  envelope-encrypted photo and article in Postgres."
fi

# Lock down the generated-env file so it isn't world-readable.
if [ -f "$GENERATED_ENV" ]; then
  chmod 600 "$GENERATED_ENV" 2>/dev/null || true
fi

# Apply pending Prisma migrations before starting the server. Idempotent —
# `migrate deploy` is the production-safe variant (no schema drift checks,
# no prompts). Fails fast if DATABASE_URL is missing or unreachable.
#
# Set RUN_MIGRATIONS=false to skip auto-migration. Recommended on platforms
# with a wall-clock limit on container startup (e.g. Railway healthcheck
# window): run `npx prisma migrate deploy` as a separate deploy hook or
# manual step so a slow migration can't time out the container boot and
# leave _prisma_migrations in a half-applied state.
if [ "${RUN_MIGRATIONS:-true}" = "true" ] && [ -n "$DATABASE_URL" ]; then
  echo "Checking migration status..."
  status_output=$(npx prisma migrate status 2>&1 || true)
  echo "$status_output"

  # Fail fast on failed / partially-applied migrations. A previous deploy
  # killed mid-migration (container reaper, platform timeout, OOM) leaves a
  # row in _prisma_migrations with started_at but no finished_at and no
  # rolled_back_at. `migrate deploy` will refuse to proceed (Prisma error
  # P3009); without this guard the entrypoint exits non-zero AT THE DEPLOY
  # STEP rather than the status step, which still works but is one round-
  # trip slower per restart. Catching at status reads cleaner in the log.
  if echo "$status_output" | grep -qE "in a failed state|partially applied|found failed migrations|migration .* failed"; then
    cat <<EOF

============================================================
FATAL: Database has migrations in a failed or stuck state.
       prisma migrate deploy will not proceed.

Diagnose by inspecting _prisma_migrations:
  SELECT migration_name, started_at, finished_at, rolled_back_at
  FROM "_prisma_migrations" ORDER BY started_at;

Repair options:
  - If the migration partially applied schema changes, fix the
    state manually and then mark it applied:
      npx prisma migrate resolve --applied <migration_name>
  - If it applied nothing and you want to retry on next deploy:
      npx prisma migrate resolve --rolled-back <migration_name>
  - On an empty database (no app tables yet) the simplest fix is:
      DELETE FROM "_prisma_migrations" WHERE finished_at IS NULL;
    then redeploy.
============================================================
EOF
    exit 1
  fi

  echo "Applying pending migrations..."
  if ! npx prisma migrate deploy; then
    cat <<EOF

FATAL: prisma migrate deploy failed (see error above).
       If the process was killed mid-migration (platform timeout,
       SIGKILL), _prisma_migrations may now have an unresolved
       entry. Resolve it before redeploying — the entrypoint will
       refuse to start on the next deploy until you do.
EOF
    exit 1
  fi
fi

exec "$@"
