#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
  DEFAULT_DEPLOY_DIR=$SCRIPT_DIR
else
  DEFAULT_DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
fi

DEPLOY_DIR=${HOME_GALLERY_DEPLOY_DIR:-$DEFAULT_DEPLOY_DIR}
COMPOSE_FILE=${HOME_GALLERY_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}
ENV_FILE=${HOME_GALLERY_ENV_FILE:-$DEPLOY_DIR/.env}
COMPOSE_PROJECT=${HOME_GALLERY_COMPOSE_PROJECT:-home-gallery}
WAIT_TIMEOUT=${HOME_GALLERY_DEPLOY_WAIT_TIMEOUT:-120}

if [[ "$COMPOSE_PROJECT" != "home-gallery" && ! "$COMPOSE_PROJECT" =~ ^home-gallery-smoke-[0-9]+$ ]]; then
  echo "ERROR: Refusing to address non-Home-Gallery Compose project: $COMPOSE_PROJECT" >&2
  exit 1
fi

dc() {
  docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --env-file "$ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

diagnostics() {
  echo "=== Home Gallery deployment diagnostics ==="
  dc ps --all || true

  for service in server gallery admin telegram-bot; do
    echo "=== $service logs (last 100 lines) ==="
    dc logs --tail 100 "$service" 2>&1 || true
  done
}

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Environment file not found: $ENV_FILE" >&2
  echo "Copy .env.example to .env, replace every placeholder, and set chmod 600." >&2
  exit 1
fi

if [[ ! "$WAIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: HOME_GALLERY_DEPLOY_WAIT_TIMEOUT must be a positive integer." >&2
  exit 1
fi

if command -v stat >/dev/null 2>&1; then
  ENV_MODE=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
  if [[ "$ENV_MODE" != "600" ]]; then
    echo "ERROR: $ENV_FILE has mode $ENV_MODE; expected 600." >&2
    exit 1
  fi
fi

echo "Validating the isolated '$COMPOSE_PROJECT' Compose project"
dc config --quiet

echo "Pulling Home Gallery images"
if ! dc pull server gallery admin telegram-bot; then
  diagnostics
  exit 1
fi

echo "Starting Home Gallery (no other Compose project is addressed)"
if ! dc up -d --wait --wait-timeout "$WAIT_TIMEOUT" \
  server gallery admin telegram-bot; then
  diagnostics
  exit 1
fi

dc ps
echo "Home Gallery deployment is healthy."
