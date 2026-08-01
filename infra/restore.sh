#!/usr/bin/env bash

set -Eeuo pipefail

if (($# != 1)); then
  echo "Usage: $0 <backup.tar.gz>" >&2
  exit 1
fi

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
REQUESTED_ARCHIVE=$1

if [[ "$COMPOSE_PROJECT" != "home-gallery" && ! "$COMPOSE_PROJECT" =~ ^home-gallery-smoke-[0-9]+$ ]]; then
  echo "ERROR: Refusing to address non-Home-Gallery Compose project: $COMPOSE_PROJECT" >&2
  exit 1
fi

mkdir -p -- "$BACKUP_DIR"
BACKUP_DIR=$(cd -- "$BACKUP_DIR" && pwd -P)
ARCHIVE_DIR=$(cd -- "$(dirname -- "$REQUESTED_ARCHIVE")" && pwd -P)
ARCHIVE_NAME=$(basename -- "$REQUESTED_ARCHIVE")
ARCHIVE_PATH="$ARCHIVE_DIR/$ARCHIVE_NAME"

if [[ "$ARCHIVE_DIR" != "$BACKUP_DIR" ]]; then
  echo "ERROR: The archive must be inside $BACKUP_DIR so the data-tools container can read it." >&2
  exit 1
fi

if [[ ! -s "$ARCHIVE_PATH" ]]; then
  echo "ERROR: Backup archive not found or empty: $ARCHIVE_PATH" >&2
  exit 1
fi

if [[ -f "$ARCHIVE_PATH.sha256" ]]; then
  (cd -- "$BACKUP_DIR" && sha256sum --check "$ARCHIVE_NAME.sha256")
fi

tar -tzf "$ARCHIVE_PATH" | while IFS= read -r entry; do
  case "$entry" in
    /* | ../* | */../* | */..)
      echo "ERROR: Unsafe path in backup archive: $entry" >&2
      exit 1
      ;;
  esac
done

if ! tar -tzf "$ARCHIVE_PATH" | grep -Eq '(^|\./)home-gallery\.db$'; then
  echo "ERROR: Backup does not contain home-gallery.db." >&2
  exit 1
fi

export HOME_GALLERY_BACKUP_DIR=$BACKUP_DIR

dc() {
  docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --env-file "$ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

RUNNING_SERVICES=()
while IFS= read -r service; do
  RUNNING_SERVICES+=("$service")
done < <(dc ps --services --status running)

restart_services() {
  if ((${#RUNNING_SERVICES[@]} > 0)); then
    dc up -d --wait --wait-timeout 120 "${RUNNING_SERVICES[@]}"
  fi
}

trap restart_services EXIT

if ((${#RUNNING_SERVICES[@]} > 0)); then
  dc stop --timeout 30 "${RUNNING_SERVICES[@]}"
fi

SAFETY_NAME="home-gallery-pre-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
echo "Saving the current volume as $BACKUP_DIR/$SAFETY_NAME"
dc run --rm --no-deps data-tools \
  sh -eu -c "tar -C /data -czf '/backups/$SAFETY_NAME' ."
(cd -- "$BACKUP_DIR" && sha256sum "$SAFETY_NAME" >"$SAFETY_NAME.sha256")

echo "Restoring $ARCHIVE_PATH"
dc run --rm --no-deps data-tools sh -eu -c "
  rm -rf /data/.restore-staging
  mkdir -p /data/.restore-staging
  tar -xzf '/backups/$ARCHIVE_NAME' -C /data/.restore-staging
  test -f /data/.restore-staging/home-gallery.db
  find /data -mindepth 1 -maxdepth 1 ! -name .restore-staging -exec rm -rf -- {} +
  cp -a /data/.restore-staging/. /data/
  rm -rf /data/.restore-staging
  chown -R 1000:1000 /data
"

echo "Restore completed. The previous data remains in $BACKUP_DIR/$SAFETY_NAME"
