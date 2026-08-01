# Production Deployment

Home Gallery ships as four `linux/amd64` images and one isolated Docker Compose project. The default LAN ports are `3010` for the gallery, `3011` for the administration application, and `3012` for the API. The web containers proxy API and media requests over the private Compose network, so browser tokens stay same-origin and no production CORS allowlist is required.

## Prerequisites

The production host needs:

- 64-bit Linux on `amd64`;
- Docker Engine with Docker Compose v2 and support for `docker compose up --wait`;
- enough persistent disk for the media library, a local backup, and temporary restore space;
- outbound HTTPS access to GHCR and the Telegram Bot API;
- an SSH user allowed to run Docker when automated deployment is enabled.

The initial target is `192.168.21.250`. Tappa remains a separate Compose project and owns ports `3000` through `3003`. Home Gallery does not join Tappa's network, mount its volumes, address its containers, or run `--remove-orphans`.

## First installation

Create the deployment directory and configuration on the host:

```bash
mkdir -p "$HOME/home-gallery/infra"
cd "$HOME/home-gallery/infra"
cp .env.example .env
chmod 600 .env
```

Replace every placeholder in `.env`:

- generate `HOME_GALLERY_API_TOKEN` with `openssl rand -hex 32`;
- set the token returned by BotFather as `HOME_GALLERY_TELEGRAM_BOT_TOKEN`;
- set `HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS` to a comma-separated allowlist of numeric Telegram user IDs;
- keep `HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES` at or below `HOME_GALLERY_MAX_UPLOAD_BYTES` so the bot rejects oversized responses before buffering them for upload;
- keep the default host ports or choose unused alternatives;
- use an absolute `HOME_GALLERY_BACKUP_DIR` on production hosts.

The API token is also the administration login token and the bot-to-server credential. It must be at least 32 characters with no whitespace. Keep `.env`, backups, databases, and uploaded media out of source control.

Log in to the private GitHub Container Registry package, then deploy:

```bash
docker login ghcr.io -u <github-user>
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
2. Obtain each contributor's numeric Telegram user ID through a trusted method.
3. Put only those IDs in `HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS`.
4. Deploy the stack and check `docker compose --project-name home-gallery logs telegram-bot` for `Telegram bot started`.
5. Send a test image from an allowed account. Confirm that it appears in the administration application and that Telegram deletes the source message only after storage succeeds.

Unauthorized messages are not downloaded. A failed upload stays in the chat and receives a failure reply.

## LAN access and first-run verification

With the default ports, open:

- `http://192.168.21.250:3010` for the unattended gallery;
- `http://192.168.21.250:3011` for administration;
- `http://192.168.21.250:3012/health` for the API health response.

The administration application asks for `HOME_GALLERY_API_TOKEN` and keeps it only in the browser session. For a stable local name, add a router DNS entry such as `home-gallery.lan` pointing to `192.168.21.250`; mDNS or per-device hosts-file entries are also suitable. Include the selected ports in the URLs unless a separate LAN reverse proxy terminates ports 80 or 443.

Verify the isolated projects and occupied ports before and after first deployment:

```bash
docker compose --project-name tappa ps
docker compose --project-name home-gallery --env-file .env ps
docker compose --project-name tappa ps
```

The Tappa output must remain unchanged, and Home Gallery must not bind ports `3000` through `3003`.

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

- Treat the default HTTP endpoints as trusted-LAN services. Put a TLS reverse proxy or authenticated private network in front of them before crossing an untrusted network; the administration bearer token is otherwise sent in cleartext over HTTP.
- The empty CORS allowlist is the production default because gallery and administration traffic is same-origin through nginx. Use explicit origins for split-origin development. `*` is an intentional escape hatch and should not be used for an exposed deployment.
- The API rejects missing or invalid bearer tokens before reading upload bodies. It validates multipart counts and sizes, verifies image bytes, limits decoded pixels, applies EXIF orientation, and stores only normalized WebP files with server-generated names.
- Telegram authorization occurs before file lookup or download. Both declared and streamed download sizes are bounded, and secrets are redacted from bot and API error logs.
- Containers run without added Linux capabilities, with read-only root filesystems and `no-new-privileges`. The web applications send a restrictive Content Security Policy and other defensive browser headers.
- Keep `.env` at mode `600`, rotate both bot and API tokens after suspected disclosure, and never paste them into issue, pull request, or diagnostic output.

The complete authorization, input, dependency, recovery, and MVP review is recorded in [VALIDATION.md](VALIDATION.md).

## Persistent data

The `home-gallery-data` Compose volume contains all state:

- `home-gallery.db` plus SQLite WAL files;
- normalized WebP media;
- temporary upload files while a request is in progress.

The server container runs as UID/GID `1000`, has a read-only root filesystem, and can write only its data volume and temporary filesystem. The bot also runs as a non-root user. Web containers use unprivileged nginx on port `8080` inside the network.

Do not edit the volume while the API server is running. Do not copy only the SQLite file: metadata and referenced media must be backed up as one coordinated unit.

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
30 3 * * * cd /home/ms/home-gallery/infra && bash backup.sh >> /var/log/home-gallery-backup.log 2>&1
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

The smoke test also verifies that the upload is visible through the gallery and administration proxies, rejects an unauthenticated administration request, updates settings through the administration proxy, and confirms a clean server exit after `SIGTERM`. Set `HOME_GALLERY_SMOKE_REPORT_RESOURCES=1` to include an idle CPU and memory snapshot in its output.

## Upgrade and rollback

The default-branch workflow publishes `latest` and immutable `sha-<12-character-commit>` tags. Automated deployment writes the matching immutable tag to the host before calling `deploy.sh`.

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

## Automated deployment

On every successful push to `main`, CI:

1. runs formatting, linting, type checking, unit tests, builds, and the Compose smoke test;
2. publishes the four private GHCR images for `linux/amd64` as `latest` and `sha-*`;
3. connects an ephemeral `tag:ci` Tailscale node;
4. discovers the remote user's home directory over SSH;
5. rsyncs only Home Gallery infrastructure files into `$HOME/home-gallery/infra`;
6. writes runtime secrets to the host `.env` with mode `600`;
7. logs the host into GHCR with the job-scoped token and runs `deploy.sh`.

Configure these repository or production-environment secrets:

- `HOME_GALLERY_TS_OAUTH_CLIENT_ID`;
- `HOME_GALLERY_TS_OAUTH_SECRET`;
- `HOME_GALLERY_DEPLOY_HOST`;
- `HOME_GALLERY_DEPLOY_USER`;
- `HOME_GALLERY_DEPLOY_SSH_KEY`;
- `HOME_GALLERY_API_TOKEN`;
- `HOME_GALLERY_TELEGRAM_BOT_TOKEN`;
- `HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS`.

Optional Actions variables `HOME_GALLERY_GALLERY_PORT`, `HOME_GALLERY_ADMIN_PORT`, and `HOME_GALLERY_API_PORT` override the three defaults. Use a dedicated Tailscale ACL grant for the CI tag and restrict the SSH key to the deployment host.

The deployment concurrency group is Home Gallery-specific and does not cancel an in-progress deployment. Failures print Compose state and recent logs for all four services.

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
- **The bot exits:** validate the BotFather token and comma-separated positive numeric allowlist, then inspect bot logs.
- **An image pull is denied:** refresh `docker login ghcr.io` with an account or token allowed to read the private packages.
- **A deployment fails:** leave Tappa untouched, inspect `docker compose --project-name home-gallery ... ps --all`, correct the cause, and rerun `deploy.sh`.
- **A restore fails health checks:** inspect server logs, keep the automatically generated pre-restore archive, and restore the last known-good archive.
