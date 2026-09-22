# Home Gallery

Home Gallery is a self-hosted application for collecting photos through Telegram and displaying them as a fullscreen browser slideshow. It also provides a web administration interface for managing the local media library.

The project is under active development. The product requirements are in [docs/SPECIFICATION.md](docs/SPECIFICATION.md), the delivery sequence is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), and execution is tracked in the [GitHub issue backlog](https://github.com/mateuszsikora/home-gallery/issues). The integrated MVP evidence and security review are in [docs/VALIDATION.md](docs/VALIDATION.md).

The MVP HTTP routes and representative payloads are documented in [docs/API.md](docs/API.md).

Production images, Docker Compose deployment, backup and restore, and rollback are documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Project status

Home Gallery is a personal project published so others can read, fork, and adapt it. It is maintained on a best-effort basis: issues and pull requests are welcome, but there is no support commitment or release schedule. Run it on a trusted network and review [docs/VALIDATION.md](docs/VALIDATION.md) before exposing it more widely.

The container images referenced by `docker-compose.yml` are published as public GHCR packages, so `docker compose pull` works without a registry login. To build them from source instead:

```bash
docker compose --env-file .env build
```

## Local development

The foundation requires Node.js 24 and the npm version bundled with it. From a clean checkout:

```bash
npm ci
npm run check
```

The repository-wide commands are:

- `npm run format` to format supported files;
- `npm run format:check` to verify formatting;
- `npm run lint` to run ESLint;
- `npm run typecheck` to run TypeScript without emitting files;
- `npm test` to run the test suite once;
- `npm run test:watch` to rerun tests while files change;
- `npm run build` to compile every workspace;
- `npm run check` to run all required checks in CI order.

The npm workspaces are the four applications under `apps/` and the three shared packages under `packages/`. They are intentionally minimal until their corresponding implementation issues are started. Copy `.env.example` to `.env` only when a later service requires local configuration; never commit credentials or runtime data.

### Running the API server

The server reads its configuration from the environment and refuses to start when a security-critical variable is missing or invalid. `.env.example` documents every variable and its default.

```bash
npm run build
HOME_GALLERY_INGESTION_TOKEN="$(openssl rand -hex 32)" \
HOME_GALLERY_DATA_DIR=./data \
npm run start --workspace @home-gallery/server
```

`GET /health` then reports the process state on `http://localhost:3012/health`. The data directory holds the SQLite database and the normalized media, and is created on first start; it must be a persistent volume in production.

### Running the fullscreen gallery

The gallery is an unattended React application that fills the browser viewport, preserves portrait and landscape images without cropping, and follows the playlist timing and playback mode returned by the API. Start it against a running API server with:

```bash
VITE_HOME_GALLERY_API_URL=http://localhost:3012 \
npm run dev --workspace @home-gallery/frontend
```

Open the Vite URL shown in the terminal. The API URL defaults to the gallery page origin when `VITE_HOME_GALLERY_API_URL` is omitted, which is suitable when a reverse proxy serves both applications on one origin. The gallery automatically retries playlist requests every 30 seconds, retains the last usable playlist while the API is unavailable, and needs no interaction during normal playback.

### Running the administration application

The administration application manages the media library, the playback settings, the Telegram contributors who may submit photos, and the password that protects the studio itself.

A fresh installation has **no administration password**: the studio opens for anyone who can reach it, and says so on every screen until a password is set from its **Security** panel. Setting, changing, or removing the password signs out every other browser and keeps the one making the change signed in. Run the gallery on a trusted network, and set a password before the server is reachable from anywhere else.

The administration application uses the same API URL and asks for the password once to create a short-lived server session. The password is never put in browser storage or a URL; subsequent requests use an opaque `HttpOnly`, `SameSite=Strict` cookie and an explicit anti-CSRF header for mutations. The in-memory session expires after eight hours by default, is invalidated by a server restart or the **Lock studio** action, and uses `Secure` automatically in the supported TLS profile. Administration uploads are disabled by default; set `HOME_GALLERY_ALLOW_ADMIN_UPLOADS=true` deliberately when browser uploads are required.

```bash
VITE_HOME_GALLERY_API_URL=http://localhost:3012 \
npm run dev --workspace @home-gallery/admin -- --port 3011
```

When the API and administration application use different origins during local development, include the administration origin in `HOME_GALLERY_ALLOWED_ORIGINS` before starting the server. For the command above, use `HOME_GALLERY_ALLOWED_ORIGINS=http://localhost:3011`. Cookie sessions require the two origins to remain same-site; the documented localhost ports satisfy that requirement. In production, the bundled reverse proxy serves the API and administration application from one origin.

### Running the Telegram bot

Create a bot with BotFather and configure the bot variables documented in `.env.example`. The bot uses the ingestion credential and cannot call administration routes.

```bash
HOME_GALLERY_TELEGRAM_BOT_TOKEN="<bot-token>" \
HOME_GALLERY_API_URL=http://localhost:3012 \
HOME_GALLERY_INGESTION_TOKEN="<server-ingestion-token>" \
HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES=26214400 \
npm run start --workspace @home-gallery/telegram-bot
```

Contributors are approved in the administration application rather than configured at deployment time. The first message from an unknown Telegram user creates a pending access request and is answered with a status reply; the bot does not look up or download anything until an administrator approves the request, and the server refuses Telegram uploads from anybody else.

Approved users can send Telegram photo messages or JPEG, PNG, WebP, HEIC, and HEIF image documents. The bot chooses the largest available Telegram photo, enforces its download limit while streaming the response, uploads it with contributor attribution, and deletes the source message only after Home Gallery confirms storage. Keep the bot download limit at or below the server upload limit. Unsupported, oversized, or unapproved submissions are not uploaded. Failed uploads remain in the chat and receive a status reply so they can be retried.

## Agent-driven development

Development is organized as one GitHub issue per pull request. A new agent session only needs this prompt:

> Read the Markdown files and continue the project.

The repository instructions in [AGENTS.md](AGENTS.md) tell the agent how to select a ready issue, implement it, validate it, and open a pull request.

## Planned architecture

The application will use a TypeScript monorepo containing:

- a Fastify API server with SQLite and local media storage;
- a React fullscreen gallery;
- a React administration application;
- a Telegram bot;
- shared API contracts and configuration utilities;
- Docker Compose deployment for local-network hosting.

Each application will remain independently deployable and communicate through public APIs or shared contracts.

## Deployment target

The MVP runs on a LAN server that may already host unrelated stacks, so Home Gallery stays self-contained: it uses its own Compose project, configuration directory, secrets, ports, containers, network, and persistent data, and never addresses another project's resources. Images are published to GHCR by CI and deployed to the host by an operator.

From a configured production checkout, validate and start the isolated stack with:

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait
```

The default LAN endpoints are gallery `:3010`, administration `:3011`, and API `:3012`. Use `npm run test:compose` to exercise image upload, restart persistence, coordinated backup, and restore in a disposable Compose project.
