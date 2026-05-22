#!/usr/bin/env bash
# Verify that NEXT_PUBLIC_SENTRY_DSN gets inlined into the production
# client bundle by `next build`.
#
# Why this exists: sentry.client.config.ts gates Sentry on
# `!!process.env.NEXT_PUBLIC_SENTRY_DSN`. Next.js replaces that expression
# at build time with the literal value of the env var. If the build env
# doesn't carry the var, the bundle ships with `enabled: false`, and EVERY
# error in production is silent — exactly the observability gap that left
# the article decryption failure undiagnosable.
#
# This script:
#   1. Sets NEXT_PUBLIC_SENTRY_DSN to a unique marker value
#   2. Runs `next build`
#   3. Searches the built client chunks for the marker
#   4. Exits 0 if found (DSN was inlined), 1 if not
#
# Run from the privapaid_app directory:
#   bash scripts/verify-sentry-dsn-inlined.sh
#
# Recommended: run this in CI before any production deploy.
#
# Time cost: ~30-90s for a full `next build`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"

# Unique marker per run — no chance of a stale artifact giving a false pass.
MARKER="sentry-dsn-verify-marker-$$-$(date +%s)"
EXPECTED_DSN="https://${MARKER}@o4510882343354368.ingest.us.sentry.io/4511095878975488"

echo "==> Verifying Sentry DSN is inlined into the production bundle"
echo "    Marker: $MARKER"

# Clean any prior build so we know any match came from this build.
rm -rf .next/static .next/standalone 2>/dev/null || true

echo "==> Running next build (this takes ~30-90s)..."
NEXT_PUBLIC_SENTRY_DSN="$EXPECTED_DSN" \
NEXTAUTH_SECRET="verify-script-placeholder" \
  npx next build > /tmp/next-build-sentry-verify.log 2>&1 || {
    echo "==> ERROR: next build failed. Tail of log:"
    tail -50 /tmp/next-build-sentry-verify.log
    exit 1
  }

echo "==> Searching client chunks for the marker..."
if [[ ! -d .next/static ]]; then
  echo "==> ERROR: .next/static directory not found. Build did not produce client artifacts."
  exit 1
fi

# grep across all built JS chunks (server + client). The marker MUST land
# in the client bundle because sentry.client.config.ts is a client-side
# entry point.
if grep -rl "$MARKER" .next/static/chunks/ > /dev/null 2>&1; then
  MATCHES=$(grep -rl "$MARKER" .next/static/chunks/ | head -5)
  echo "==> PASS: Sentry DSN marker found in client bundle"
  echo "    Files containing the marker:"
  echo "$MATCHES" | sed 's/^/      /'
  exit 0
fi

# Not found in client chunks. Check whether it landed ONLY in the server
# bundle — that's a misconfiguration where sentry.client.config.ts isn't
# being processed as a client entry point.
if grep -rl "$MARKER" .next/server/ > /dev/null 2>&1; then
  echo "==> FAIL: Sentry DSN marker found ONLY in server bundle, not in client chunks."
  echo "         sentry.client.config.ts isn't reaching the browser bundle."
  echo "         Browser-side errors will NOT be captured by Sentry."
  exit 1
fi

echo "==> FAIL: Sentry DSN marker NOT found in any built artifact."
echo "          The build process is not inlining NEXT_PUBLIC_SENTRY_DSN."
echo "          Browser-side errors will NOT be captured by Sentry."
echo
echo "    Check:"
echo "    - Dockerfile lines 18-19 declare ARG and ENV for NEXT_PUBLIC_SENTRY_DSN"
echo "    - docker-compose.prod.yml passes the build arg from the host env"
echo "    - .deploy.env on the deploy machine has NEXT_PUBLIC_SENTRY_DSN= set"
echo "    - scripts/deploy-demo.sh uses 'sudo env VAR=val docker-compose build'"
exit 1
