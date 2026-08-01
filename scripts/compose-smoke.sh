#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_DIR=$(mktemp -d)
PROJECT_NAME="home-gallery-smoke-$RANDOM"
API_TOKEN=compose-smoke-api-token-0123456789abcdef

export HOME_GALLERY_API_TOKEN=$API_TOKEN
export HOME_GALLERY_TELEGRAM_BOT_TOKEN=123456789:compose_smoke_token_1234567890
export HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS=123456789
export HOME_GALLERY_GALLERY_PORT=${HOME_GALLERY_SMOKE_GALLERY_PORT:-33110}
export HOME_GALLERY_ADMIN_PORT=${HOME_GALLERY_SMOKE_ADMIN_PORT:-33111}
export HOME_GALLERY_API_PORT=${HOME_GALLERY_SMOKE_API_PORT:-33112}
export HOME_GALLERY_BACKUP_DIR=$TEMP_DIR/backups
export HOME_GALLERY_COMPOSE_PROJECT=$PROJECT_NAME
export HOME_GALLERY_ENV_FILE=$REPOSITORY_ROOT/.env.example

dc() {
  docker compose \
    --project-name "$PROJECT_NAME" \
    --env-file "$REPOSITORY_ROOT/.env.example" \
    --file "$REPOSITORY_ROOT/docker-compose.yml" \
    "$@"
}

cleanup() {
  local status=$?

  if ((status != 0)); then
    dc ps --all || true
    dc logs --tail 100 server gallery admin 2>&1 || true
  fi

  dc down --volumes --timeout 10 >/dev/null 2>&1 || true
  rm -rf -- "$TEMP_DIR"
  exit "$status"
}

trap cleanup EXIT

mkdir -p "$HOME_GALLERY_BACKUP_DIR"

PROJECT_GUARD_OUTPUT=$(
  HOME_GALLERY_COMPOSE_PROJECT=tappa \
    "$REPOSITORY_ROOT/infra/deploy.sh" 2>&1 || true
)
if ! grep -q 'Refusing to address non-Home-Gallery Compose project: tappa' \
  <<<"$PROJECT_GUARD_OUTPUT"; then
  echo "ERROR: Deployment project isolation guard did not reject Tappa." >&2
  exit 1
fi

dc config --quiet
UP_OPTIONS=(-d --wait --wait-timeout 180)
if [[ "${HOME_GALLERY_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  dc build telegram-bot
  UP_OPTIONS+=(--build)
fi
dc up "${UP_OPTIONS[@]}" server gallery admin

curl --fail --silent --show-error "http://127.0.0.1:$HOME_GALLERY_API_PORT/health" |
  grep -q '"status":"ok"'
curl --fail --silent --show-error "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/" |
  grep -q '<title>Home Gallery</title>'
curl --fail --silent --show-error --head \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/" |
  grep -qi '^content-security-policy:'
curl --fail --silent --show-error "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/" |
  grep -q '<title>Home Gallery Admin</title>'

printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' |
  openssl base64 -d -A >"$TEMP_DIR/smoke.png"

UPLOAD_RESPONSE=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $API_TOKEN" \
  --form "file=@$TEMP_DIR/smoke.png;type=image/png" \
  --form 'originalFilename=smoke.png' \
  --form 'source=api' \
  "http://127.0.0.1:$HOME_GALLERY_API_PORT/api/media")
MEDIA_ID=$(printf '%s' "$UPLOAD_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

if [[ -z "$MEDIA_ID" ]]; then
  echo "ERROR: Upload response did not contain a media ID: $UPLOAD_RESPONSE" >&2
  exit 1
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/api/playlist" |
  grep -q "$MEDIA_ID"
ADMIN_MEDIA_RESPONSE=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if ! grep -q "$MEDIA_ID" <<<"$ADMIN_MEDIA_RESPONSE"; then
  echo "ERROR: Uploaded media was not visible through the admin API proxy." >&2
  exit 1
fi
UNAUTHORIZED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if [[ "$UNAUTHORIZED_STATUS" != "401" ]]; then
  echo "ERROR: Admin API proxy returned $UNAUTHORIZED_STATUS without a token." >&2
  exit 1
fi
curl --fail --silent --show-error \
  --request PATCH \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"slideDurationMs":2500}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/settings" |
  grep -q '"slideDurationMs":2500'
curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/api/playlist" |
  grep -q '"slideDurationMs":2500'
curl --fail --silent --show-error \
  --output /dev/null \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/media/$MEDIA_ID"

if [[ "${HOME_GALLERY_SMOKE_REPORT_RESOURCES:-0}" == "1" ]]; then
  echo "Idle container resource snapshot:"
  RESOURCE_CONTAINERS=($(dc ps --quiet server gallery admin))
  docker stats --no-stream \
    --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' \
    "${RESOURCE_CONTAINERS[@]}"
fi

dc stop --timeout 15 server
SERVER_CONTAINER_ID=$(dc ps --all --quiet server)
SERVER_EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "$SERVER_CONTAINER_ID")
if [[ "$SERVER_EXIT_CODE" != "0" ]]; then
  echo "ERROR: Server exited with $SERVER_EXIT_CODE after SIGTERM." >&2
  exit 1
fi
dc up -d --wait --wait-timeout 120 server
curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_API_PORT/api/playlist" |
  grep -q "$MEDIA_ID"

"$REPOSITORY_ROOT/infra/backup.sh"
BACKUP_PATH=$(find "$HOME_GALLERY_BACKUP_DIR" -maxdepth 1 \
  -name 'home-gallery-*.tar.gz' ! -name '*pre-restore*' | head -n 1)

curl --fail --silent --show-error \
  --request DELETE \
  --header "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:$HOME_GALLERY_API_PORT/api/media/$MEDIA_ID"

"$REPOSITORY_ROOT/infra/restore.sh" "$BACKUP_PATH"
curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/api/playlist" |
  grep -q "$MEDIA_ID"
curl --fail --silent --show-error \
  --output /dev/null \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/media/$MEDIA_ID"
curl --fail --silent --show-error \
  --header "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media" |
  grep -q "$MEDIA_ID"

echo "Compose MVP integration, graceful shutdown, persistence, backup, and restore smoke test passed."
