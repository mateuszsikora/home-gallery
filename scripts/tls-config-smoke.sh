#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_JSON=$(mktemp)
UNSAFE_ENV=$(mktemp)

cleanup() {
  rm -f -- "$CONFIG_JSON" "$UNSAFE_ENV"
}
trap cleanup EXIT

sed 's/^HOME_GALLERY_TLS_ENABLED=false$/HOME_GALLERY_TLS_ENABLED=true/' \
  "$REPOSITORY_ROOT/.env.example" >"$UNSAFE_ENV"
chmod 600 "$UNSAFE_ENV"

DEPLOY_GUARD_OUTPUT=$(
  HOME_GALLERY_ENV_FILE=$UNSAFE_ENV \
    "$REPOSITORY_ROOT/infra/deploy.sh" 2>&1 || true
)
if ! grep -q \
  'TLS deployments require HOME_GALLERY_HTTP_BIND_ADDRESS=127.0.0.1' \
  <<<"$DEPLOY_GUARD_OUTPUT"; then
  echo "ERROR: TLS deployment guard accepted public plain-HTTP bindings." >&2
  exit 1
fi

export HOME_GALLERY_HTTP_BIND_ADDRESS=127.0.0.1

docker compose \
  --env-file "$REPOSITORY_ROOT/.env.example" \
  --file "$REPOSITORY_ROOT/docker-compose.yml" \
  --file "$REPOSITORY_ROOT/docker-compose.tls.yml" \
  config --format json >"$CONFIG_JSON"

node - "$CONFIG_JSON" <<'NODE'
const { readFileSync } = require('node:fs');

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));

for (const serviceName of ['server', 'gallery', 'admin']) {
  const ports = config.services[serviceName].ports ?? [];
  if (ports.length !== 1 || ports[0].host_ip !== '127.0.0.1') {
    throw new Error(`${serviceName} plain-HTTP port is not loopback-only`);
  }
}

if (
  config.services.server.environment.HOME_GALLERY_TRUSTED_PROXIES !==
  'uniquelocal'
) {
  throw new Error('TLS profile did not configure its private proxy trust');
}

const caddyPorts = config.services.caddy.ports ?? [];
if (!caddyPorts.some((port) => String(port.published) === '443')) {
  throw new Error('TLS profile does not publish the HTTPS port');
}
NODE

docker run --rm \
  --env HOME_GALLERY_TLS_GALLERY_HOST=gallery.example.com \
  --env HOME_GALLERY_TLS_ADMIN_HOST=admin.gallery.example.com \
  --volume "$REPOSITORY_ROOT/docker/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.11.4-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "TLS Compose and Caddy configuration smoke check passed."
