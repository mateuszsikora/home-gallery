# Production Deployment

Home Gallery ships as four `linux/amd64` application images and one isolated Docker Compose project. The default trusted-LAN profile exposes ports `3010` for the gallery, `3011` for the administration application, and `3012` for the API. An optional TLS profile adds Caddy 2.11.4, exposes only ports 80 and 443 beyond the host, and binds the three plain-HTTP ports to loopback. The web containers proxy API and media requests over the private Compose network, so browser administration sessions stay same-origin and no production CORS allowlist is required.

## Prerequisites

The production host needs:

- 64-bit Linux on `amd64`;
- Docker Engine with Docker Compose v2 and support for `docker compose up --wait`;
- enough persistent disk for the media library, a local backup, and temporary restore space;
- outbound HTTPS access to GHCR and the Telegram Bot API.

This guide writes the deployment host as `HOST` (an IP address or DNS name on your LAN); substitute your own value. When the host already runs other Compose projects, Home Gallery stays isolated from them: it never joins another project's network, mounts its volumes, addresses its containers, or runs `--remove-orphans`. The default host ports `3010` through `3012` are chosen to avoid the common `3000`–`3003` range and are configurable in `.env`.

## First installation

Create the deployment directory and configuration on the host:

```bash
mkdir -p "$HOME/home-gallery/infra"
cd "$HOME/home-gallery/infra"
cp .env.example .env
chmod 600 .env
```

Replace every placeholder in `.env`:

- generate a `HOME_GALLERY_INGESTION_TOKEN` value with `openssl rand -hex 32`;
- set the token returned by BotFather as `HOME_GALLERY_TELEGRAM_BOT_TOKEN`;
- keep `HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES` at or below `HOME_GALLERY_MAX_UPLOAD_BYTES` so the bot rejects oversized responses before buffering them for upload;
- keep the default host ports or choose unused alternatives;
- use an absolute `HOME_GALLERY_BACKUP_DIR` on production hosts.

The ingestion token must be at least 32 characters with no whitespace. It can only upload media and is used by the Telegram bot. Administration is not configured here: a new deployment starts with no administration password, and the administrator sets one from the administration application's Security panel after the first sign-in. Keep `.env`, backups, databases, uploaded media, and Caddy certificate storage out of source control.

The GHCR packages are public, so the host needs no registry login. Deploy:

```bash
bash deploy.sh
```

The deploy script validates `.env`, requires mode `600`, explicitly selects Compose project `home-gallery`, pulls the configured image tag, starts the four services, and waits for their health checks. Deployment, backup, and restore reject every project name except `home-gallery` and disposable `home-gallery-smoke-*` test projects. They never run `docker compose down` or address another project.

For a source checkout instead of GHCR images:

```bash
cp .env.example .env
# Replace every placeholder, then:
chmod 600 .env
docker compose --env-file .env up -d --build --wait
```

## Telegram setup

1. Use BotFather to create a bot and copy its token into `.env`.
2. Deploy the stack and check `docker compose --project-name home-gallery logs telegram-bot` for `Telegram bot started`.
3. Ask each contributor to write to the bot once. The first message creates a pending access request and is answered with a note that the request is waiting.
4. Open the administration application, review the request under **Contributors**, and approve or reject it. No deployment change or restart is involved.
5. Send a test image from the approved account. Confirm that it appears in the administration application and that Telegram deletes the source message only after storage succeeds.

Media from a contributor who is pending or rejected is never looked up or downloaded, and the server refuses it even if a client asks. A failed upload stays in the chat and receives a failure reply. Rejecting an approved contributor takes effect on their next message; media they already contributed stays in the library until it is deleted.

## LAN access and first-run verification

With the default ports, open:

- `http://HOST:3010` for the unattended gallery;
- `http://HOST:3011` for administration;
- `http://HOST:3012/health` for the API health response.

A new deployment has no administration password, so the administration application opens for anyone who can reach it and says so until a password is set from its Security panel. Set one before exposing the deployment beyond a trusted network. The application then asks for that password once and exchanges it for an opaque HttpOnly browser session; it does not store the password. Browser uploads are rejected unless `HOME_GALLERY_ALLOW_ADMIN_UPLOADS=true`; leave the default in place when Telegram or another ingestion client is the only uploader, and the application hides its upload control instead of offering an action the server will refuse. For a stable local name, add a router DNS entry such as `home-gallery.lan` pointing to `HOST`; mDNS or per-device hosts-file entries are also suitable. Include the selected ports in the URLs unless the supported TLS profile or another LAN reverse proxy terminates ports 80 or 443.

When the host runs other Compose projects, verify their state and the occupied ports before and after first deployment:

```bash
docker compose --project-name OTHER_PROJECT ps
docker compose --project-name home-gallery --env-file .env ps
docker compose --project-name OTHER_PROJECT ps
```

The other project's output must remain unchanged, and Home Gallery must bind only its own configured ports.

## Supported public TLS profile

Use this profile before exposing Home Gallery beyond a trusted LAN or authenticated private overlay. It requires two public DNS names that resolve to the deployment host and inbound TCP ports 80 and 443; UDP 443 enables HTTP/3. Caddy obtains and renews public certificates automatically. Do not use the example domains.

Set these values in `.env`:

```dotenv
HOME_GALLERY_TLS_ENABLED=true
HOME_GALLERY_HTTP_BIND_ADDRESS=127.0.0.1
HOME_GALLERY_TLS_GALLERY_HOST=gallery.example.com
HOME_GALLERY_TLS_ADMIN_HOST=admin.gallery.example.com
HOME_GALLERY_TLS_HTTP_PORT=80
HOME_GALLERY_TLS_HTTPS_PORT=443
```

Then deploy normally:

```bash
bash deploy.sh
```

`deploy.sh` automatically adds `docker-compose.tls.yml`, refuses TLS mode unless the direct HTTP bindings are loopback-only, validates both Compose files, and starts Caddy with the application. The gallery and administration names terminate TLS separately and proxy to their corresponding nginx containers. The API remains available through both HTTPS origins, while the direct `3010` through `3012` endpoints are reachable only from the host.

Validate this profile without issuing a certificate or starting the stack:

```bash
npm run test:tls-config
```

This check resolves the merged Compose model, asserts the loopback-only HTTP bindings and private proxy trust, and asks the pinned Caddy image to validate `docker/Caddyfile`. Certificate state is stored in a dedicated Caddy volume. Preserve that volume across routine deployments; it is operational state but does not contain gallery media or application credentials.

If Caddy runs behind another CDN or load balancer, do not automatically trust that intermediary's forwarded headers. Add only its documented egress CIDRs to Caddy and `HOME_GALLERY_TRUSTED_PROXIES`, and confirm the complete proxy chain with focused tests before relying on client-address rate limits.

## Credential scope, rotation, and throttling

The ingestion token is rotatable without a synchronized outage:

1. copy its current value into `HOME_GALLERY_INGESTION_TOKEN_PREVIOUS`;
2. generate and install a new primary value;
3. run `bash deploy.sh`;
4. update the Telegram bot and verify the new value;
5. clear `HOME_GALLERY_INGESTION_TOKEN_PREVIOUS` and deploy again;
6. verify that the retired value returns `401`.

The administration password is rotated from the administration application instead, and needs no deployment: changing it signs out every other browser immediately and keeps the one making the change signed in. `HOME_GALLERY_ALLOW_ADMIN_UPLOADS=true` is the explicit compatibility control for browser uploads and should be enabled only when that feature is needed; it lets an administration session reach the otherwise ingestion-only upload route, including while no password is set. Changing it does need a restart, and the administration application shows or hides its upload control to match on the next sign-in.

### Recovering a forgotten administration password

The password lives in the gallery database, not in the deployment configuration, so recovery means clearing its row. The server image already carries the SQLite driver, so this needs no additional download. On the deployment host:

```bash
docker compose --project-name home-gallery --env-file .env run --rm --no-deps \
  --entrypoint node server --input-type=commonjs \
  -e "new (require('better-sqlite3'))(process.env.HOME_GALLERY_DATA_DIR + '/home-gallery.db').prepare('DELETE FROM admin_credentials').run()"
docker compose --project-name home-gallery --env-file .env restart server
```

The gallery is unprotected from that moment until a new password is set, so run this only from the host itself and set a new password immediately afterwards. Take a backup first if the database state matters.

Browser administration sessions live only in bounded server memory and contain no stored credential. `HOME_GALLERY_ADMIN_SESSION_TTL_MS` defaults to eight hours and accepts one minute through seven days; `HOME_GALLERY_ADMIN_SESSION_MAX` defaults to 64 and caps concurrent sessions at 10,000. A server restart, explicit logout, expiry, or capacity eviction invalidates a session. The default LAN profile uses a non-`Secure` cookie because it runs over HTTP and is appropriate only on a trusted network. The supported TLS profile overrides `HOME_GALLERY_ADMIN_SESSION_SECURE=true`; do not disable it for HTTPS deployments.

Authentication failures default to 10 attempts per client address per 60 seconds. Authenticated uploads default to 30 attempts per client address per 60 seconds. Configure the two limits independently with `HOME_GALLERY_AUTH_RATE_LIMIT_*` and `HOME_GALLERY_UPLOAD_RATE_LIMIT_*`. A blocked request returns `429` and `Retry-After`; public gallery playback remains outside both limiters. The server logs the first limit event in a window with the proxy-aware client address and scope, then suppresses repeated limit events at the default log level so an attack cannot overwhelm useful logs.

Forwarded client addresses are ignored by default. `HOME_GALLERY_TRUSTED_PROXIES` accepts only explicit IP addresses, CIDRs, or the documented `loopback`, `linklocal`, and `uniquelocal` range aliases. The supported TLS profile sets `uniquelocal` because the API is reachable only through loopback or the dedicated Compose network. Do not configure a trust-all proxy value, and do not expose the direct API port while trusting broad client-network ranges.

## Configuration validation and diagnostics

Validate interpolation without starting containers:

```bash
docker compose --env-file .env.example config --quiet
docker compose --env-file .env config --quiet
```

The checked-in example contains non-secret placeholders so the first command succeeds. Those placeholders are not usable production credentials.

Inspect service state and logs with an explicit project name:

```bash
docker compose --project-name home-gallery --env-file .env ps --all
docker compose --project-name home-gallery --env-file .env logs --tail 100 server
docker compose --project-name home-gallery --env-file .env logs --tail 100 telegram-bot
```

Startup fails early when required secrets, Telegram IDs, ports, upload and download limits, or origins are invalid. The API health endpoint returns `503` with a `degraded` body when its database probe fails, so Compose marks the server and dependent web containers unhealthy. A web container is healthy only when it can reach the API through the private network.

## Security boundaries

- Treat the default HTTP endpoints as trusted-LAN services. Enable the supported TLS profile or use an authenticated private network before crossing an untrusted network; the one-time browser password exchange and ingestion bearer requests are otherwise sent in cleartext over HTTP.
- The empty CORS allowlist is the production default because gallery and administration traffic is same-origin through nginx. Use explicit same-site origins for split-origin development; explicit origins enable credentialed CORS for the administration cookie. `*` cannot support credentialed sessions and should not be used for an exposed deployment.
- Browser administration uses a bounded, short-lived, opaque HttpOnly session cookie. SameSite strictness and the required custom header protect cookie-authenticated mutations against CSRF. The TLS profile marks the cookie `Secure`, and authorization and cookie headers are redacted from API logs.
- The administration password is stored only as a salted scrypt hash, is never logged, and is never returned by the API. A rejected password consumes the same bounded authentication limit as any other failed credential. The API rejects missing or invalid credentials before reading upload bodies. It validates multipart counts and sizes, verifies image bytes, limits decoded pixels, applies EXIF orientation, and stores only normalized WebP files with server-generated names.
- Telegram authorization occurs before file lookup or download. Both declared and streamed download sizes are bounded, and secrets are redacted from bot and API error logs.
- Containers run without added Linux capabilities, with read-only root filesystems and `no-new-privileges`. The web applications send a restrictive Content Security Policy and other defensive browser headers.
- Keep `.env` at mode `600`, rotate the BotFather and ingestion credentials and the administration password after suspected disclosure, and never paste them into issue, pull request, or diagnostic output.

The complete authorization, input, dependency, recovery, and MVP review is recorded in [VALIDATION.md](VALIDATION.md).

## Persistent data

The `home-gallery-data` Compose volume contains all state:

- `home-gallery.db` plus SQLite WAL files;
- normalized WebP media;
- temporary upload files while a request is in progress.

The server container runs as UID/GID `1000`, has a read-only root filesystem, and can write only its data volume and temporary filesystem. The bot also runs as a non-root user. Web containers use unprivileged nginx on port `8080` inside the network.

Do not edit the volume while the API server is running. Do not copy only the SQLite file: metadata and referenced media must be backed up as one coordinated unit.

The administration password hash lives in that database, so a backup carries whichever password was in force when it was taken. Restoring an older backup restores that password along with the library; if it is not the current one, sign in with the older password or clear the row as described in [Recovering a forgotten administration password](#recovering-a-forgotten-administration-password).

## Backup

Run a local backup manually:

```bash
cd "$HOME/home-gallery/infra"
bash backup.sh
```

`backup.sh` records whether the server and bot are running, stops only those writers, archives the complete data volume, validates the tar archive, writes a SHA-256 checksum, and restores the previous service state. Gallery and administration pages may be briefly unavailable while the snapshot is taken.

Defaults can be changed for one invocation:

```bash
HOME_GALLERY_BACKUP_RETENTION_DAYS=30 \
HOME_GALLERY_BACKUP_RSYNC_TARGET=backup@example.net:/srv/backups/home-gallery \
bash backup.sh
```

Schedule it during a quiet period, for example:

```cron
30 3 * * * cd "$HOME/home-gallery/infra" && bash backup.sh >> /var/log/home-gallery-backup.log 2>&1
```

Keep at least one copy on another machine or storage device. Monitor failed cron jobs and periodically verify both the `.tar.gz` and `.sha256` files.

## Restore test and recovery

Restore accepts archives only from `HOME_GALLERY_BACKUP_DIR`. This prevents an accidental bind mount of an unrelated host path.

```bash
cd "$HOME/home-gallery/infra"
bash restore.sh "$HOME/home-gallery/infra/backups/home-gallery-20260801T030000Z.tar.gz"
```

The restore script verifies the checksum when present, rejects unsafe archive paths, requires `home-gallery.db`, records the currently running services, stops only this Compose project, and creates a `home-gallery-pre-restore-*` safety archive before replacing the volume contents. It then restores the previous service state and waits for health checks.

After every restore test:

1. open the administration media list and settings;
2. verify that a known item is present in `/api/playlist`;
3. load that item's `/media/{id}` URL;
4. upload and delete a disposable image;
5. retain the pre-restore safety archive until the result is accepted.

The repository automates this sequence with `npm run test:compose`: it starts an isolated test project, uploads an image, restarts the stack, backs it up, deletes it, restores it, and verifies metadata and bytes. The test project and volume are removed on completion.

The smoke test also verifies passwordless session creation, setting an administration password, the refusal of a missing or wrong one, cookie-authenticated reads, CSRF enforcement, logout, restart invalidation, ingestion and administration scope separation, visibility through both web proxies, an unauthenticated rejection, and a clean server exit after `SIGTERM`. Set `HOME_GALLERY_SMOKE_REPORT_RESOURCES=1` to include an idle CPU and memory snapshot in its output.

## Upgrade and rollback

The default-branch workflow publishes `latest` and immutable `sha-<12-character-commit>` tags. Pin the tag you want in the host `.env` before calling `deploy.sh`.

**Upgrading past the release that removed `HOME_GALLERY_ADMIN_TOKEN` leaves the administration application unprotected.** Compose no longer passes the variable, the server starts without it, and a panel that was credential-protected before the upgrade is open to the whole network afterwards; the only runtime signal is a `warn` line in the server log. Immediately after that upgrade, open the administration application, set a password from its Security panel, and delete the now-unused `HOME_GALLERY_ADMIN_TOKEN` and `HOME_GALLERY_ADMIN_TOKEN_PREVIOUS` lines from `.env`.

For a manual upgrade:

```bash
bash backup.sh
# Set HOME_GALLERY_IMAGE_TAG to latest or a selected sha-* tag in .env.
bash deploy.sh
```

For an application rollback, choose a previously published tag without modifying the volume:

```bash
# In .env:
HOME_GALLERY_IMAGE_TAG=sha-0123456789ab

bash deploy.sh
```

Always take a backup before upgrading. A future release may include a database migration that older application code cannot read. In that case, restore the backup made immediately before the upgrade as well as pinning the older image tag.

## Continuous integration

On every successful push to `main`, CI:

1. runs formatting, linting, type checking, unit tests, builds, and the Compose smoke test;
2. publishes the four GHCR images for `linux/amd64` as `latest` and `sha-*`.

Image publishing uses the job-scoped `GITHUB_TOKEN`, so it needs no additional secrets.

CI does not deliver those images to a host. Deployment is a separate, operator-driven step: pull the chosen tag on the deployment host and run `deploy.sh` as described in [First installation](#first-installation) and [Upgrade and rollback](#upgrade-and-rollback).

## Capacity and routine operations

Normalized images are often smaller than camera originals, but capacity depends heavily on resolution and content. Establish a baseline after importing a representative batch:

```bash
docker system df -v
docker volume inspect home-gallery_home-gallery-data
du -sh "$HOME/home-gallery/infra/backups"
```

Reserve enough space for the live volume, at least one full local backup, temporary restore staging, container images, and normal filesystem headroom. A practical minimum is more than twice the measured live data size plus image storage; add alerting before the filesystem reaches 80% utilization. Adjust `HOME_GALLERY_MAX_STORED_FILES` and the upload limit to the host's budget.

Routine checks should cover:

- `GET /health` and all four Compose health states;
- backup age and checksum verification;
- free disk and inode capacity;
- repeated bot/API errors in logs;
- availability of a known immutable rollback tag;
- a scheduled restore exercise on an isolated host.

## Troubleshooting

- **Compose reports a missing variable:** replace every credential placeholder and re-run `docker compose ... config --quiet`.
- **The deploy script rejects `.env`:** run `chmod 600 .env`.
- **The gallery or admin is unhealthy:** check the server health and the private `home-gallery` network first; both web health endpoints proxy the API.
- **The server cannot write data:** inspect volume ownership and confirm the container still runs as UID/GID `1000`.
- **The bot exits:** validate the BotFather token and the ingestion credential, then inspect bot logs.
- **A contributor is stuck waiting:** confirm their request is listed under **Contributors** in the administration application and approve it there; the bot reports every contact it could not register.
- **An image pull fails:** the packages are public and need no login, so confirm the host's outbound HTTPS access to `ghcr.io` and that the requested `HOME_GALLERY_IMAGE_TAG` exists.
- **A deployment fails:** leave any other Compose project untouched, inspect `docker compose --project-name home-gallery ... ps --all`, correct the cause, and rerun `deploy.sh`.
- **A restore fails health checks:** inspect server logs, keep the automatically generated pre-restore archive, and restore the last known-good archive.
