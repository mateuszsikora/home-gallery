# Implementation Plan

## 1. Delivery model

Home Gallery will be delivered incrementally. Every implementation unit is represented by a GitHub issue and completed in a dedicated pull request. Issues contain their own acceptance criteria and dependency list; agents must only select issues whose dependencies have been merged.

The MVP is complete when a permitted Telegram user can submit an image, the server can validate and store it, the image appears in the browser slideshow, an administrator can manage it, and the complete system can be deployed with Docker Compose.

## 2. Technical direction

The repository will be an npm-workspaces TypeScript monorepo targeting Node.js 26 to match the established CI and container baseline of the deployment host.

```text
home-gallery/
├── apps/
│   ├── telegram-bot/
│   ├── server/
│   ├── frontend/
│   └── admin/
├── packages/
│   ├── shared-types/
│   ├── config/
│   └── api-client/
├── docker/
├── docs/
└── docker-compose.yml
```

The intended stack is:

- Fastify for the HTTP API;
- SQLite for metadata and configuration;
- local persistent storage for normalized media;
- Sharp/libvips for image verification, EXIF-aware rotation, and WebP normalization;
- React and Vite for the gallery and administration applications;
- Telegraf for Telegram Bot API integration;
- Node's test runner or Vitest for automated tests;
- Docker Compose for deployment.

An issue may adjust a library choice when implementation evidence justifies it, but changes to component boundaries or storage architecture must be documented in the pull request.

## 3. API boundaries

The planned MVP API is:

| Method   | Path              | Access          | Purpose                                     |
| -------- | ----------------- | --------------- | ------------------------------------------- |
| `GET`    | `/health`         | Public          | Liveness and readiness signal               |
| `POST`   | `/api/media`      | Ingestion token | Validate, normalize, and store an image     |
| `GET`    | `/api/media`      | Admin session   | List all media for administration           |
| `GET`    | `/api/media/{id}` | Admin session   | Return media metadata                       |
| `PATCH`  | `/api/media/{id}` | Admin session   | Enable, disable, or reorder media           |
| `DELETE` | `/api/media/{id}` | Admin session   | Delete metadata and its local file          |
| `GET`    | `/api/playlist`   | Public          | Return enabled media and slideshow settings |
| `GET`    | `/media/{id}`     | Public          | Stream an enabled normalized image          |
| `GET`    | `/api/settings`   | Admin session   | Read gallery settings                       |
| `PATCH`  | `/api/settings`   | Admin session   | Update gallery settings                     |

Post-MVP issue #26 adds `/api/telegram/contributors` so contributor access is granted in the administration application instead of in deployment configuration.

The MVP initially used one bearer token. Post-MVP issue #21 separates bot ingestion and administrative operations into independently rotatable credentials while preserving these route boundaries. Post-MVP issue #24 keeps bearer support for API clients while replacing browser bearer storage with bounded, short-lived administration sessions.

## 4. Data model

Each media record contains:

- UUID;
- internal filename and sanitized original filename;
- media type and normalized MIME type;
- upload timestamp and author/source identity;
- enabled state and explicit sort order;
- width and height.

SQLite stores metadata, settings, and Telegram contributor approval state. Media bytes live under a configurable data directory mounted as a persistent Docker volume. Database writes and file moves must avoid leaving a record without a file or an untracked permanent file after a failed request.

Initial gallery settings are slide duration, fade duration, sequential or shuffled playback, and how a photo that does not match the shape of the display is fitted to the screen.

## 5. Implementation sequence

### Phase A — Foundation

1. [#1 — Establish the TypeScript monorepo and CI foundation](https://github.com/mateuszsikora/home-gallery/issues/1).
2. [#2 — Define shared API contracts and the typed client](https://github.com/mateuszsikora/home-gallery/issues/2).

### Phase B — Server

3. [#3 — Build the server, configuration, database, and storage foundation](https://github.com/mateuszsikora/home-gallery/issues/3).
4. [#4 — Implement secure image upload and normalization](https://github.com/mateuszsikora/home-gallery/issues/4).
5. [#5 — Complete media management, playlist, and settings APIs](https://github.com/mateuszsikora/home-gallery/issues/5).

### Phase C — User interfaces

6. [#6 — Build the unattended fullscreen gallery](https://github.com/mateuszsikora/home-gallery/issues/6).
7. [#7 — Build the media administration application](https://github.com/mateuszsikora/home-gallery/issues/7).

### Phase D — Integration and deployment

8. [#8 — Implement the allowlisted Telegram ingestion bot](https://github.com/mateuszsikora/home-gallery/issues/8).
9. [#9 — Add production Docker Compose deployment](https://github.com/mateuszsikora/home-gallery/issues/9).
10. [#10 — Harden and validate the integrated MVP](https://github.com/mateuszsikora/home-gallery/issues/10).

The matching GitHub issues are the source of truth for execution state. This document describes architecture and order; it must not be used to infer that an issue is complete.

## 6. Deployment target and coexistence

The first production target is an existing LAN server that already runs unrelated Compose projects. The established deployment pattern on that host is:

- Linux `amd64` images are built by GitHub Actions and published as public GHCR packages;
- an on-host deploy script pulls immutable `sha-*` or `latest` image tags, runs Docker Compose, and verifies health checks;
- on-host secrets are created with restrictive permissions and are never committed;
- each project owns a prefixed directory under `$HOME`, prefixed Compose project and container names, its own network and volumes, and a distinct host port range.

Home Gallery must reuse the operational pattern, not another project's resources. Its planned defaults are:

| Resource              | Home Gallery value                         |
| --------------------- | ------------------------------------------ |
| Host architecture     | `linux/amd64`                              |
| Remote directory      | `$HOME/home-gallery/infra`                 |
| Compose project       | `home-gallery`                             |
| Gallery port          | `3010`                                     |
| Admin port            | `3011`                                     |
| API port              | `3012`                                     |
| Container DNS/network | Dedicated `home-gallery` Compose network   |
| Persistent data       | Dedicated media and SQLite volume or mount |
| Images                | `ghcr.io/mateuszsikora/home-gallery-*`     |

All host ports must remain environment-configurable. Home Gallery deployment automation must use its own GitHub secrets, deployment concurrency group, container names, network, and backup target. It must never stop, recreate, or use `--remove-orphans` against a Compose project it does not own. Rollback must be possible by redeploying a known `sha-*` image tag.

SQLite metadata and original/normalized media need a coordinated backup procedure of their own. The deployment issue must include a restore test and capacity guidance because the media library can consume substantially more disk than typical application data.

## 7. Quality gates

Every implementation pull request must pass the checks available at that stage. By the end of Phase A, the repository must expose consistent commands for formatting, linting, type checking, tests, and builds. Later issues must preserve those checks.

High-risk behavior requires focused tests:

- upload type, size, integrity, and image-orientation handling;
- authorization on all mutation and administration endpoints;
- atomic media/database deletion and upload failure recovery;
- Telegram contributor approval and deletion only after confirmed server success;
- gallery recovery from an empty or temporarily unreachable playlist;
- data persistence across container restarts.

## 8. Explicit non-goals for the MVP

- video playback or transcoding;
- albums, tags, favorites, and multiple playlists;
- real-time WebSocket or SSE updates;
- multiple roles or a user account system;
- cloud object storage;
- advanced slideshow transitions beyond fade.
