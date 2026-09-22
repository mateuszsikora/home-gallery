# Contributing

Home Gallery is a personal project, published so others can read, fork, and adapt it. Issues and pull requests are welcome, but it is maintained on a best-effort basis: there is no support commitment, no release schedule, and no guarantee that a proposed change fits the scope in [docs/SPECIFICATION.md](docs/SPECIFICATION.md).

All repository content that can appear on GitHub is written in English — code, tests, documentation, issue and pull request text, commit messages, and user-facing copy.

## Security reports do not belong here

Do not open an issue or a pull request for a suspected vulnerability. [SECURITY.md](SECURITY.md) describes private reporting and the threat model that decides what is in scope.

## Reporting a bug

Say what you ran, what happened, and what you expected instead. The deployment profile decides most of the answer, so include it: the default plain-HTTP profile or the TLS profile, a pulled image tag or a build from source, and the relevant `HOME_GALLERY_*` settings with their values redacted. Server logs from around the failure usually settle a report on their own.

## Proposing a change

Open an issue before writing code for anything larger than a small fix. This is a narrow project with a written scope, and an issue costs less than a rejected pull request.

## Pull requests

One issue per pull request. Before opening one:

```bash
npm ci
npm run check
```

`npm run check` runs the CI sequence: `format:check`, `lint`, `typecheck`, `test`, and `build`. Changes to the Compose stack, the images, or the deployment scripts also need `npm run test:compose`, which exercises upload, restart persistence, backup, and restore in a disposable Compose project.

A pull request should:

- use an English title and description, and close its issue with `Closes #<issue-number>`;
- summarize the behavior delivered rather than the files touched;
- list the validation commands that were run, and their results;
- cover new behavior with automated tests;
- contain only the changes its issue needs, with any follow-up work named rather than silently folded in.

## How the project is built

Most of this codebase is written by coding agents, one issue per pull request, under the instructions in [AGENTS.md](AGENTS.md). Pull requests from people are held to the same bar, which is where the requirements above come from. [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md) describes the loop.
