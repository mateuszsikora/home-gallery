# Security Policy

## Supported versions

Home Gallery is developed on `main` and published as a rolling `latest` tag plus immutable `sha-<commit>` container images. Only `main` receives fixes. Older image tags are retained so a deployment can roll back, and are never patched in place.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/mateuszsikora/home-gallery/security/advisories/new). Do not use a public issue, pull request, or discussion for a security report.

A useful report identifies the affected component, the configuration profile it applies to, the request or input sequence that triggers it, and what an attacker gains. A proof of concept is welcome.

This is a personal project maintained on a best-effort basis. There is no response-time commitment and no coordinated disclosure schedule. A fix may take time, and a report that falls outside the threat model below may be declined with an explanation rather than patched.

## Threat model

The documented deployment is a trusted LAN or an authenticated private overlay network. The default profile serves plain HTTP and is not intended to face the public internet; [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) describes the supported TLS profile for wider exposure, and [docs/VALIDATION.md](docs/VALIDATION.md) records the existing review.

In scope:

- authentication or authorization bypass in the API, including the administration session exchange and the boundary between the administration and ingestion credentials;
- bypass of the Telegram contributor approval flow;
- upload handling, covering image parsing, size and decoded-pixel limits, path traversal, and stored file naming;
- injection, deserialization, or traversal reachable from an unauthenticated request;
- container escape or privilege escalation out of the published images.

Out of scope:

- exposing the default plain-HTTP profile to an untrusted network, which the documentation already advises against;
- absent rate limiting or hardening on a path where the documented configuration disables it deliberately;
- dependency advisories with no demonstrated impact on this project; report those to the upstream project;
- resource exhaustion on a host provisioned below the documented capacity guidance;
- findings that presuppose an already-compromised host, a leaked administration token, or physical access.

## Credential handling

Administration, ingestion, and Telegram bot credentials live only in the host `.env` at mode `600`. They are not committed, are not baked into the container images, and are redacted from API and bot logs. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) documents how to rotate each credential independently without a synchronized outage.
