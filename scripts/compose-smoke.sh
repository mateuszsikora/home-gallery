#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TEMP_DIR=$(mktemp -d)
PROJECT_NAME="home-gallery-smoke-$RANDOM"
INGESTION_TOKEN=compose-smoke-ingestion-token-0123456789abcd
ADMIN_PASSWORD=compose-smoke-administration-password

export HOME_GALLERY_INGESTION_TOKEN=$INGESTION_TOKEN
export HOME_GALLERY_TELEGRAM_BOT_TOKEN=123456789:compose_smoke_token_1234567890
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
  HOME_GALLERY_COMPOSE_PROJECT=unrelated-project \
    "$REPOSITORY_ROOT/infra/deploy.sh" 2>&1 || true
)
if ! grep -q 'Refusing to address non-Home-Gallery Compose project: unrelated-project' \
  <<<"$PROJECT_GUARD_OUTPUT"; then
  echo "ERROR: Deployment project isolation guard did not reject a foreign project." >&2
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

open_admin_session() {
  # Usage: open_admin_session <cookie-jar> [password]
  local jar=$1
  local password=${2:-}
  local payload='{}'

  if [[ -n "$password" ]]; then
    payload="{\"password\":\"$password\"}"
  fi

  curl --silent --show-error --output "$TEMP_DIR/session-body.json" \
    --write-out '%{http_code}' \
    --cookie-jar "$jar" \
    --request POST \
    --header 'X-Home-Gallery-CSRF: 1' \
    --header 'Content-Type: application/json' \
    --data "$payload" \
    "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/session"
}

AUTH_STATUS_RESPONSE=$(curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/auth")
if ! grep -q '"passwordConfigured":false' <<<"$AUTH_STATUS_RESPONSE"; then
  echo "ERROR: A fresh gallery reported a configured password: $AUTH_STATUS_RESPONSE" >&2
  exit 1
fi
# The Compose default leaves browser uploads off, and the administration app
# hides its upload control on the strength of this field alone.
if ! grep -q '"administrationUploadsEnabled":false' <<<"$AUTH_STATUS_RESPONSE"; then
  echo "ERROR: The default deployment advertised browser uploads: $AUTH_STATUS_RESPONSE" >&2
  exit 1
fi

SESSION_COOKIE_JAR=$TEMP_DIR/admin-session.cookies
SESSION_STATUS=$(open_admin_session "$SESSION_COOKIE_JAR")
if [[ "$SESSION_STATUS" != "201" ]]; then
  echo "ERROR: Passwordless administration session received $SESSION_STATUS." >&2
  exit 1
fi
if ! grep -q '"expiresAt"' "$TEMP_DIR/session-body.json"; then
  echo "ERROR: Administration session response has no expiry." >&2
  exit 1
fi
if ! grep -q 'home_gallery_admin_session' "$SESSION_COOKIE_JAR"; then
  echo "ERROR: Administration session cookie was not stored." >&2
  exit 1
fi

MISSING_SESSION_CSRF_STATUS=$(curl --silent --output /dev/null \
  --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/session")
if [[ "$MISSING_SESSION_CSRF_STATUS" != "403" ]]; then
  echo "ERROR: Session creation without CSRF received $MISSING_SESSION_CSRF_STATUS." >&2
  exit 1
fi

curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media" |
  grep -q '"items"'
MISSING_CSRF_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie "$SESSION_COOKIE_JAR" \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --data '{"slideDurationMs":3000}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/settings")
if [[ "$MISSING_CSRF_STATUS" != "403" ]]; then
  echo "ERROR: Cookie mutation without CSRF header received $MISSING_CSRF_STATUS." >&2
  exit 1
fi
curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  --request PATCH \
  --header 'X-Home-Gallery-CSRF: 1' \
  --header 'Content-Type: application/json' \
  --data '{"slideDurationMs":3000}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/settings" |
  grep -q '"slideDurationMs":3000'
curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  --cookie-jar "$SESSION_COOKIE_JAR" \
  --request DELETE \
  --header 'X-Home-Gallery-CSRF: 1' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/session"
LOGGED_OUT_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie "$SESSION_COOKIE_JAR" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if [[ "$LOGGED_OUT_STATUS" != "401" ]]; then
  echo "ERROR: Logged-out administration session received $LOGGED_OUT_STATUS." >&2
  exit 1
fi

# From here on the gallery is password protected, which is the state a finished
# installation is expected to be left in.
SESSION_STATUS=$(open_admin_session "$SESSION_COOKIE_JAR")
if [[ "$SESSION_STATUS" != "201" ]]; then
  echo "ERROR: Reopening a passwordless session received $SESSION_STATUS." >&2
  exit 1
fi
curl --fail --silent --show-error --output /dev/null \
  --cookie "$SESSION_COOKIE_JAR" \
  --request PUT \
  --header 'X-Home-Gallery-CSRF: 1' \
  --header 'Content-Type: application/json' \
  --data "{\"newPassword\":\"$ADMIN_PASSWORD\"}" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/password"

AUTH_STATUS_RESPONSE=$(curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/auth")
if ! grep -q '"passwordConfigured":true' <<<"$AUTH_STATUS_RESPONSE"; then
  echo "ERROR: The configured password was not published: $AUTH_STATUS_RESPONSE" >&2
  exit 1
fi

NO_PASSWORD_STATUS=$(open_admin_session "$TEMP_DIR/rejected.cookies")
if [[ "$NO_PASSWORD_STATUS" != "401" ]]; then
  echo "ERROR: A session without the password received $NO_PASSWORD_STATUS." >&2
  exit 1
fi
WRONG_PASSWORD_STATUS=$(open_admin_session "$TEMP_DIR/rejected.cookies" 'not-the-password')
if [[ "$WRONG_PASSWORD_STATUS" != "401" ]]; then
  echo "ERROR: A wrong password received $WRONG_PASSWORD_STATUS." >&2
  exit 1
fi
SESSION_STATUS=$(open_admin_session "$SESSION_COOKIE_JAR" "$ADMIN_PASSWORD")
if [[ "$SESSION_STATUS" != "201" ]]; then
  echo "ERROR: The correct password received $SESSION_STATUS." >&2
  exit 1
fi
if grep -q "$ADMIN_PASSWORD" "$TEMP_DIR/session-body.json"; then
  echo "ERROR: The administration password was echoed by the API." >&2
  exit 1
fi
if grep -q "$ADMIN_PASSWORD" "$SESSION_COOKIE_JAR"; then
  echo "ERROR: The administration password leaked into the cookie jar." >&2
  exit 1
fi

REMOVE_MISSING_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie "$SESSION_COOKIE_JAR" \
  --request DELETE \
  --header 'X-Home-Gallery-CSRF: 1' \
  --header 'Content-Type: application/json' \
  --data '{"currentPassword":"not-the-password"}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/admin/password")
if [[ "$REMOVE_MISSING_STATUS" != "403" ]]; then
  echo "ERROR: Removing with a wrong password received $REMOVE_MISSING_STATUS." >&2
  exit 1
fi

printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' |
  openssl base64 -d -A >"$TEMP_DIR/smoke.png"

ADMIN_UPLOAD_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie "$SESSION_COOKIE_JAR" \
  --header 'X-Home-Gallery-CSRF: 1' \
  --form "file=@$TEMP_DIR/smoke.png;type=image/png" \
  --form 'originalFilename=smoke.png' \
  --form 'source=admin' \
  "http://127.0.0.1:$HOME_GALLERY_API_PORT/api/media")
# 403, never 401: the session is valid, and 401 is what tells the
# administration app that a session expired.
if [[ "$ADMIN_UPLOAD_STATUS" != "403" ]]; then
  echo "ERROR: Administration session received $ADMIN_UPLOAD_STATUS from the ingestion-only route." >&2
  exit 1
fi

UPLOAD_RESPONSE=$(curl --fail --silent --show-error \
  --header "Authorization: Bearer $INGESTION_TOKEN" \
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
  --cookie "$SESSION_COOKIE_JAR" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if ! grep -q "$MEDIA_ID" <<<"$ADMIN_MEDIA_RESPONSE"; then
  echo "ERROR: Uploaded media was not visible through the admin API proxy." >&2
  exit 1
fi
INGESTION_ADMIN_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "Authorization: Bearer $INGESTION_TOKEN" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if [[ "$INGESTION_ADMIN_STATUS" != "401" ]]; then
  echo "ERROR: Ingestion credential received $INGESTION_ADMIN_STATUS from an administration route." >&2
  exit 1
fi
UNAUTHORIZED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if [[ "$UNAUTHORIZED_STATUS" != "401" ]]; then
  echo "ERROR: Admin API proxy returned $UNAUTHORIZED_STATUS without a session." >&2
  exit 1
fi
curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  --request PATCH \
  --header 'X-Home-Gallery-CSRF: 1' \
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

open_admin_session "$SESSION_COOKIE_JAR" "$ADMIN_PASSWORD" >/dev/null

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
RESTARTED_SESSION_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie "$SESSION_COOKIE_JAR" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media")
if [[ "$RESTARTED_SESSION_STATUS" != "401" ]]; then
  echo "ERROR: Administration session survived a server restart." >&2
  exit 1
fi

"$REPOSITORY_ROOT/infra/backup.sh"
BACKUP_PATH=$(find "$HOME_GALLERY_BACKUP_DIR" -maxdepth 1 \
  -name 'home-gallery-*.tar.gz' ! -name '*pre-restore*' | head -n 1)

open_admin_session "$SESSION_COOKIE_JAR" "$ADMIN_PASSWORD" >/dev/null
curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  --request DELETE \
  --header 'X-Home-Gallery-CSRF: 1' \
  "http://127.0.0.1:$HOME_GALLERY_API_PORT/api/media/$MEDIA_ID"

"$REPOSITORY_ROOT/infra/restore.sh" "$BACKUP_PATH"
curl --fail --silent --show-error \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/api/playlist" |
  grep -q "$MEDIA_ID"
curl --fail --silent --show-error \
  --output /dev/null \
  "http://127.0.0.1:$HOME_GALLERY_GALLERY_PORT/media/$MEDIA_ID"
# The restore restarts the server, so the studio has to sign in again with the
# password the backup carries.
open_admin_session "$SESSION_COOKIE_JAR" "$ADMIN_PASSWORD" >/dev/null
curl --fail --silent --show-error \
  --cookie "$SESSION_COOKIE_JAR" \
  "http://127.0.0.1:$HOME_GALLERY_ADMIN_PORT/api/media" |
  grep -q "$MEDIA_ID"

echo "Compose MVP integration, graceful shutdown, persistence, backup, and restore smoke test passed."
