#!/bin/sh
# =============================================================================
# First-run seed script for Docker deployments.
# Seeds default categories and creates the initial superadmin account.
# Idempotent — safe to run multiple times.
#
# Usage:
#   docker compose exec app sh scripts/docker-seed.sh
#
# Required env vars: DATABASE_URL, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
# =============================================================================

set -e

echo "=== Media App — First-Run Seed ==="
echo ""

# Verify required env vars
for var in DATABASE_URL ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD; do
  eval value=\$$var
  if [ -z "$value" ]; then
    echo "ERROR: $var is not set. Add it to your .env file."
    exit 1
  fi
done

echo "Seeding categories and admin account..."
npx tsx scripts/seed-all.ts

echo ""
echo "=== Seed complete ==="
echo "Log in at: ${NEXTAUTH_URL:-http://localhost:3000}/admin"
echo "Email: $ADMIN_EMAIL"
