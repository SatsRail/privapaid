#!/usr/bin/env bash
# Deploy latest code to your PrivaPaid demo instance.
# Usage: bash scripts/deploy-demo.sh
#
# Requires a .deploy.env file in the project root:
#   DEPLOY_SSH_KEY=~/.ssh/your-key
#   DEPLOY_HOST=ec2-user@your-ip
#   DEPLOY_APP_DIR=/home/ec2-user/privapaid
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.deploy.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing .deploy.env file. Create one in the project root:"
  echo ""
  echo "  DEPLOY_SSH_KEY=~/.ssh/your-key"
  echo "  DEPLOY_HOST=ec2-user@your-ip"
  echo "  DEPLOY_APP_DIR=/home/ec2-user/privapaid"
  exit 1
fi

source "$ENV_FILE"

: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY in .deploy.env}"
: "${DEPLOY_HOST:?Set DEPLOY_HOST in .deploy.env}"
: "${DEPLOY_APP_DIR:=/home/ec2-user/privapaid}"

# Public-safe build args. Inlined into the client bundle by `next build`,
# so they MUST be in the shell env when docker-compose builds — otherwise
# ${VAR:-} substitution in docker-compose.prod.yml resolves to empty and
# the production bundle embeds an empty Sentry DSN (silent in production).
# Set these in .deploy.env. Empty defaults preserve the existing behavior
# for anyone who hasn't added them yet.
: "${NEXT_PUBLIC_SENTRY_DSN:=}"
: "${NEXT_PUBLIC_INSTANCE_NAME:=}"

KEEP_RELEASES=3

echo "==> Deploying to ${DEPLOY_HOST}..."

# Shorthand so the SSH command lines read like sentences instead of a wall.
remote() { ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_HOST" "$@"; }
COMPOSE="docker-compose -f docker-compose.yml -f docker-compose.prod.yml"

echo "==> Pulling latest code..."
remote "cd $DEPLOY_APP_DIR && git pull && git submodule update --init --recursive"

echo "==> Rebuilding and restarting containers..."
# `sudo env VAR=value docker-compose ...` is the only reliable way to pass
# the Sentry DSN into docker-compose's ${VAR} substitution across the sudo
# boundary. `sudo -E` doesn't work on Amazon Linux defaults — env vars
# not in env_keep get stripped before docker-compose ever sees them.
remote "cd $DEPLOY_APP_DIR && sudo env \
  NEXT_PUBLIC_SENTRY_DSN='$NEXT_PUBLIC_SENTRY_DSN' \
  NEXT_PUBLIC_INSTANCE_NAME='$NEXT_PUBLIC_INSTANCE_NAME' \
  $COMPOSE build --no-cache app"
remote "cd $DEPLOY_APP_DIR && sudo $COMPOSE up -d"

echo "==> Waiting for health check..."
for i in $(seq 1 30); do
  HEALTH=$(remote "curl -sf http://localhost:3000/api/health 2>/dev/null" || echo "")
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "==> Health check passed: $HEALTH"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "==> ERROR: Health check failed after 150s"
    remote "cd $DEPLOY_APP_DIR && sudo docker-compose logs --tail 20 app"
    exit 1
  fi
  echo "    Waiting... ($i/30)"
  sleep 5
done

echo "==> Pruning old releases (keeping ${KEEP_RELEASES})..."
ssh -i "$DEPLOY_SSH_KEY" "$DEPLOY_HOST" bash -s "$KEEP_RELEASES" <<'CLEANUP'
  KEEP=$1
  # Remove stopped containers
  sudo docker container prune -f 2>/dev/null || true
  # Remove old images beyond the last N
  sudo docker images --format '{{.ID}} {{.CreatedAt}}' --filter 'dangling=false' \
    | sort -k2 -r | awk -v keep="$KEEP" 'NR>keep {print $1}' \
    | xargs -r sudo docker rmi -f 2>/dev/null || true
  # Remove dangling images and build cache
  sudo docker image prune -f 2>/dev/null || true
  sudo docker builder prune -af 2>/dev/null || true
  echo "Disk after cleanup: $(df -h / | tail -1 | awk '{print $4 " free (" $5 " used)"}')"
CLEANUP

echo "==> Deploy complete!"
