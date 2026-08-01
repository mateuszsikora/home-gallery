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
CONFIGURED_BACKUP_DIR=
if [[ -f "$ENV_FILE" ]]; then
  CONFIGURED_BACKUP_DIR=$(awk -F= \
    '$1 == "HOME_GALLERY_BACKUP_DIR" { print substr($0, index($0, "=") + 1) }' \
    "$ENV_FILE" | tail -n 1)
fi
BACKUP_DIR=${HOME_GALLERY_BACKUP_DIR:-${CONFIGURED_BACKUP_DIR:-$DEPLOY_DIR/backups}}
if [[ "$BACKUP_DIR" != /* ]]; then
  BACKUP_DIR=$DEPLOY_DIR/$BACKUP_DIR
fi
RETENTION_DAYS=${HOME_GALLERY_BACKUP_RETENTION_DAYS:-14}
OFFSITE_TARGET=${HOME_GALLERY_BACKUP_RSYNC_TARGET:-}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_NAME="home-gallery-$STAMP.tar.gz"
ARCHIVE_PATH="$BACKUP_DIR/$ARCHIVE_NAME"

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

if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: HOME_GALLERY_BACKUP_RETENTION_DAYS must be a positive integer." >&2
  exit 1
fi

mkdir -p -- "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
export HOME_GALLERY_BACKUP_DIR=$BACKUP_DIR

SERVER_WAS_RUNNING=false
BOT_WAS_RUNNING=false
SERVICES_RESTORED=false
if dc ps --services --status running | grep -qx server; then
  SERVER_WAS_RUNNING=true
fi
if dc ps --services --status running | grep -qx telegram-bot; then
  BOT_WAS_RUNNING=true
fi

restart_services() {
  local services=()

  if [[ "$SERVICES_RESTORED" == true ]]; then
    return
  fi

  if [[ "$SERVER_WAS_RUNNING" == true ]]; then
    services+=(server)
  fi
  if [[ "$BOT_WAS_RUNNING" == true ]]; then
    services+=(telegram-bot)
  fi

  if ((${#services[@]} > 0)); then
    dc up -d --wait --wait-timeout 120 "${services[@]}"
  fi

  SERVICES_RESTORED=true
}

trap restart_services EXIT

if [[ "$BOT_WAS_RUNNING" == true ]]; then
  dc stop --timeout 30 telegram-bot
fi
if [[ "$SERVER_WAS_RUNNING" == true ]]; then
  dc stop --timeout 30 server
fi

echo "Creating a coordinated data snapshot: $ARCHIVE_PATH"
dc run --rm --no-deps data-tools \
  sh -eu -c "tar -C /data -czf '/backups/$ARCHIVE_NAME' ."

restart_services

if [[ ! -s "$ARCHIVE_PATH" ]]; then
  echo "ERROR: Backup archive was not created." >&2
  exit 1
fi

tar -tzf "$ARCHIVE_PATH" >/dev/null
(cd -- "$BACKUP_DIR" && sha256sum "$ARCHIVE_NAME" >"$ARCHIVE_NAME.sha256")

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'home-gallery-*.tar.gz' -o -name 'home-gallery-*.tar.gz.sha256' \) \
  -mtime "+$RETENTION_DAYS" -delete

if [[ -n "$OFFSITE_TARGET" ]]; then
  rsync -a --partial "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256" "$OFFSITE_TARGET/"
fi

echo "Backup verified: $ARCHIVE_PATH"
