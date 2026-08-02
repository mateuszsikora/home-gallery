# MVP Validation and Security Review

This document records the integrated MVP review completed for issue #10. It complements the operator procedure in [DEPLOYMENT.md](DEPLOYMENT.md) and the route contract in [API.md](API.md).

## Automated evidence

The repository-wide `npm run check` command runs formatting, linting, TypeScript checking, unit and component tests, and production builds. `npm run test:compose` then exercises the built containers and real reverse proxies in a disposable Compose project.

The Compose scenario proves this sequence:

1. start healthy server, gallery, and administration containers;
2. upload a real PNG through the bearer-protected API;
3. read the item through the public gallery playlist and content proxy;
4. read the same administrative record through the authenticated administration proxy and reject the same request without a token;
5. change slideshow settings through the administration proxy and observe them through the public playlist;
6. stop the server with `SIGTERM`, require exit code `0`, restart it, and verify persisted metadata;
7. create a coordinated database/media backup, delete the item, restore the backup, and verify both its metadata and normalized bytes.

Focused tests additionally cover image signatures, corruption, EXIF orientation, decoded-pixel limits, multipart limits, concurrent file-count reservations, upload cleanup after database failure, deletion rollback after database failure, startup cleanup, pagination, authorization on every administrative route, CORS, token redaction, bounded Telegram downloads, delete-on-success bot behavior, slideshow recovery, and every administration mutation.

Run the clean-checkout gates with Node.js 24:

```bash
npm ci
npm audit --audit-level=high
npm run check
docker compose --env-file .env.example config --quiet
npm run test:tls-config
npm run test:compose
```

## Security review

| Area               | Evidence and result                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization      | Upload and administration use independently rotatable credentials with timing-safe comparison. Ingestion credentials cannot manage media or settings, and administration credentials cannot upload unless explicitly enabled. Health, playlist, and enabled normalized media are deliberately public. Tests cover scope, rotation overlap, and rejection before request-body reads.                                             |
| Untrusted input    | Strict runtime schemas reject unknown metadata and mutation fields. Multipart part, field, file-count, field-size, and byte limits are configured. Sharp verifies actual bytes, rejects unsupported formats, caps decoded pixels, applies orientation, and emits WebP to a server-generated path.                                                                                                                               |
| Telegram ingestion | The numeric allowlist is checked before lookup or download. Declared and streamed response sizes are capped. Every external operation has a timeout. Source messages are deleted only after the API confirms storage.                                                                                                                                                                                                           |
| Database and files | Uploads use same-filesystem temporary files and atomic rename, and remove normalized bytes if the database insert fails. Deletes hide bytes by atomic rename and restore them if the database delete fails. Startup removes interrupted temporary work. SQLite uses WAL, foreign keys, a busy timeout, and transactional migrations and ordering updates.                                                                       |
| Browser boundary   | Production traffic is same-origin by default. CORS is disabled unless explicit origins are configured. nginx applies CSP, frame, MIME-sniffing, referrer, and permissions headers; direct API responses apply the relevant defensive headers too. The admin token is session-only and never enters URLs or build output. The optional Caddy profile validates automatic TLS termination and loopback-only direct HTTP bindings. |
| Secrets and logs   | Secrets enter containers at runtime, `.env` is required to use mode `600` for deployment, API authorization and cookies are redacted, and bot errors replace configured tokens before logging. No credentials or runtime data are committed.                                                                                                                                                                                    |
| Containers         | Application containers are non-root, drop all capabilities, use read-only root filesystems, enable `no-new-privileges`, isolate their network and volume, and never address the Tappa Compose project.                                                                                                                                                                                                                          |
| Dependencies       | On 2026-08-01, `npm ci` followed by `npm audit --audit-level=high` reported zero vulnerabilities for the locked dependency graph. CI rebuilds and retests from the lockfile on every pull request.                                                                                                                                                                                                                              |

The default LAN deployment uses HTTP and is appropriate only on a trusted network. The defense-in-depth work in [issue #21](https://github.com/mateuszsikora/home-gallery/issues/21) adds a validated Caddy TLS profile, explicit trusted-proxy configuration, bounded invalid-authentication and upload attempts, and separate administration and ingestion credentials. Public gallery playback does not consume either limiter. Deployments still need correct DNS, firewall policy, credential rotation, and monitoring; application controls do not turn a household service into a public multi-tenant platform.

## Resource expectations

Home Gallery is designed for one household-scale gallery and modest hardware, not for public multi-tenant traffic. Resource use is dominated by Sharp while decoding and normalizing an upload; galleries and administration pages are static nginx processes, and SQLite is normally idle between requests.

Capture a reproducible idle snapshot after the integration upload with:

```bash
HOME_GALLERY_SMOKE_REPORT_RESOURCES=1 npm run test:compose
```

A reference run on 2026-08-01 used the production `linux/amd64` images under Docker Desktop emulation. After one stored image, the server used 95.32 MiB, gallery nginx used 14.75 MiB, and administration nginx used 14.77 MiB at idle (124.84 MiB combined, with 0.00–0.13% sampled CPU). Uploading and normalizing a 2,800 × 2,800 incompressible PNG of 23,560,841 bytes raised the sampled server maximum to 154.5 MiB and approximately one CPU core. The Telegram container was excluded because the isolated test intentionally has no live BotFather credential. These figures are a sizing reference, not a hard limit; architecture, allocator behavior, image complexity, and concurrent requests change the result.

For production sizing, measure with representative camera images and the configured maximum upload size. Reserve at least 512 MiB of RAM for the four services plus operating-system and Docker overhead; 1 GiB or more of total host RAM is the practical floor. An individual image normalization can temporarily exceed idle memory, so reduce `HOME_GALLERY_MAX_UPLOAD_BYTES` and `HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES` together on constrained hosts. Disk capacity must cover the live volume, one complete local backup, restore staging, images, and normal filesystem headroom as described in [DEPLOYMENT.md](DEPLOYMENT.md#capacity-and-routine-operations).

## MVP reconciliation

The implemented MVP satisfies the specification checklist:

- allowlisted Telegram users can submit supported photos with attribution;
- the API validates, normalizes, stores, lists, reorders, enables, disables, serves, and deletes media;
- the unattended gallery handles empty, sequential, shuffled, offline, portrait, and landscape states with preloading and fades;
- the administration application supports session-scoped authentication, upload, preview, visibility, ordering, deletion, and slideshow settings;
- Docker Compose provides isolated, persistent, non-root services with health checks, deployment automation, backup, restore, and immutable-tag rollback.

Video, accounts and roles, multiple playlists, and real-time updates remain explicit post-MVP work. The TLS and credential-hardening controls are deliberately optional so the trusted-LAN deployment remains simple, and their limits are documented rather than silently expanding the current operational claims.
