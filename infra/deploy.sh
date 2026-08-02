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
TLS_COMPOSE_FILE=${HOME_GALLERY_TLS_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.tls.yml}
ENV_FILE=${HOME_GALLERY_ENV_FILE:-$DEPLOY_DIR/.env}
COMPOSE_PROJECT=${HOME_GALLERY_COMPOSE_PROJECT:-home-gallery}
WAIT_TIMEOUT=${HOME_GALLERY_DEPLOY_WAIT_TIMEOUT:-120}
COMPOSE_FILES=(--file "$COMPOSE_FILE")
DEPLOY_SERVICES=(server gallery admin telegram-bot)

env_value() {
  local variable=$1
  awk -F= -v variable="$variable" \
    '$1 == variable { print substr($0, index($0, "=") + 1) }' \
    "$ENV_FILE" | tail -n 1
}

if [[ "$COMPOSE_PROJECT" != "home-gallery" && ! "$COMPOSE_PROJECT" =~ ^home-gallery-smoke-[0-9]+$ ]]; then
  echo "ERROR: Refusing to address non-Home-Gallery Compose project: $COMPOSE_PROJECT" >&2
  exit 1
fi

dc() {
  docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --env-file "$ENV_FILE" \
    "${COMPOSE_FILES[@]}" \
    "$@"
}

diagnostics() {
  echo "=== Home Gallery deployment diagnostics ==="
  dc ps --all || true

  for service in "${DEPLOY_SERVICES[@]}"; do
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

TLS_ENABLED=$(env_value HOME_GALLERY_TLS_ENABLED)
if [[ "$TLS_ENABLED" != "" && "$TLS_ENABLED" != "true" && "$TLS_ENABLED" != "false" ]]; then
  echo "ERROR: HOME_GALLERY_TLS_ENABLED must be true or false." >&2
  exit 1
fi

if [[ "$TLS_ENABLED" == "true" ]]; then
  if [[ ! -f "$TLS_COMPOSE_FILE" ]]; then
    echo "ERROR: TLS Compose file not found: $TLS_COMPOSE_FILE" >&2
    exit 1
  fi

  HTTP_BIND_ADDRESS=$(env_value HOME_GALLERY_HTTP_BIND_ADDRESS)
  if [[ "$HTTP_BIND_ADDRESS" != "127.0.0.1" ]]; then
    echo "ERROR: TLS deployments require HOME_GALLERY_HTTP_BIND_ADDRESS=127.0.0.1." >&2
    exit 1
  fi

  COMPOSE_FILES+=(--file "$TLS_COMPOSE_FILE")
  DEPLOY_SERVICES+=(caddy)
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
if ! dc pull "${DEPLOY_SERVICES[@]}"; then
  diagnostics
  exit 1
fi

echo "Starting Home Gallery (no other Compose project is addressed)"
if ! dc up -d --wait --wait-timeout "$WAIT_TIMEOUT" \
  "${DEPLOY_SERVICES[@]}"; then
  diagnostics
  exit 1
fi

dc ps
echo "Home Gallery deployment is healthy."
