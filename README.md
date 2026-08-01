# Home Gallery

Home Gallery is a self-hosted application for collecting photos through Telegram and displaying them as a fullscreen browser slideshow. It also provides a web administration interface for managing the local media library.

The project is under active development. The product requirements are in [docs/SPECIFICATION.md](docs/SPECIFICATION.md), the delivery sequence is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), and execution is tracked in the [GitHub issue backlog](https://github.com/mateuszsikora/home-gallery/issues).

The MVP HTTP routes and representative payloads are documented in [docs/API.md](docs/API.md).

Production images, Docker Compose deployment, backup and restore, rollback, and the Tailscale/SSH delivery workflow are documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
HOME_GALLERY_API_TOKEN="$(openssl rand -hex 32)" \
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

The administration application uses the same API URL and asks for the API bearer token in the browser. The token is kept in `sessionStorage`, is never included in a URL, and is removed when the studio is locked or the tab session ends.

```bash
VITE_HOME_GALLERY_API_URL=http://localhost:3012 \
npm run dev --workspace @home-gallery/admin -- --port 3011
```

When the API and administration application use different origins during local development, include the administration origin in `HOME_GALLERY_ALLOWED_ORIGINS` before starting the server. For the command above, use `HOME_GALLERY_ALLOWED_ORIGINS=http://localhost:3011`. In production, a reverse proxy can serve the API and administration application from one origin.

### Running the Telegram bot

Create a bot with BotFather, obtain the numeric Telegram user IDs that may contribute, and configure the bot variables documented in `.env.example`. The bot and server use the same `HOME_GALLERY_API_TOKEN` value.

```bash
HOME_GALLERY_TELEGRAM_BOT_TOKEN="<bot-token>" \
HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS="123456789,987654321" \
HOME_GALLERY_API_URL=http://localhost:3012 \
HOME_GALLERY_API_TOKEN="<server-api-token>" \
npm run start --workspace @home-gallery/telegram-bot
```

Allowed users can send Telegram photo messages or JPEG, PNG, WebP, HEIC, and HEIF image documents. The bot chooses the largest available Telegram photo, uploads it with contributor attribution, and deletes the source message only after Home Gallery confirms storage. Unsupported or unauthorized submissions are not downloaded. Failed uploads remain in the chat and receive a status reply so they can be retried.

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

The MVP will run on the same LAN server as Tappa (`192.168.21.250`) while remaining an independent stack. Home Gallery will use its own Compose project, configuration directory, secrets, ports, containers, network, and persistent data. The deployment plan deliberately follows Tappa's proven private-GHCR and Tailscale/SSH delivery workflow without coupling either application's runtime.

From a configured production checkout, validate and start the isolated stack with:

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait
```

The default LAN endpoints are gallery `:3010`, administration `:3011`, and API `:3012`. Use `npm run test:compose` to exercise image upload, restart persistence, coordinated backup, and restore in a disposable Compose project.
