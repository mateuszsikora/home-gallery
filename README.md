# Home Gallery

Home Gallery is a self-hosted application for collecting photos through Telegram and displaying them as a fullscreen browser slideshow. It also provides a web administration interface for managing the local media library.

The project is under active development. The product requirements are in [docs/SPECIFICATION.md](docs/SPECIFICATION.md), the delivery sequence is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), and execution is tracked in the [GitHub issue backlog](https://github.com/mateuszsikora/home-gallery/issues).

The MVP HTTP routes and representative payloads are documented in [docs/API.md](docs/API.md).

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
