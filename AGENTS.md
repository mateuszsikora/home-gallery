# Agent Instructions

All repository content that can appear on GitHub must be written in English. This includes source code, tests, documentation, issue and pull request text, commit messages, comments, and user-facing copy.

## Starting a work session

When the user asks you to read the Markdown files or continue the project:

1. Read every tracked Markdown file in the repository before changing code.
2. Inspect the open GitHub issues with `gh issue list --state open` and read the relevant issue bodies.
3. Select exactly one open issue whose listed dependencies are complete. Prefer the lowest-numbered ready issue unless the user specifies another issue.
4. Confirm that the selected issue is not already covered by an open pull request. If it is, select the next ready issue.
5. Implement only the selected issue and any small prerequisite fix that is strictly required for it. Do not combine unrelated backlog items.
6. Follow the acceptance criteria in the issue and the architecture in `docs/IMPLEMENTATION_PLAN.md`.
7. Add or update automated tests for behavior introduced by the change.
8. Run the narrowest relevant checks, then run the repository-wide checks required by the issue.
9. Review `git diff origin/main...` for accidental or unrelated changes.
10. Commit the work with an English conventional commit message, push the workspace branch, and open a pull request against `main`.

## Pull request requirements

Every implementation session ends with a pull request unless the selected issue is genuinely blocked. The pull request must:

- have an English title and description;
- use `Closes #<issue-number>` in its description; a repository chore requested directly by the user — documentation, CI configuration, a dependency bump — may give a one-line reason instead, under the exception in [CONTRIBUTING.md](CONTRIBUTING.md), but implementation work always closes an issue;
- summarize the behavior delivered;
- list the validation commands and results;
- identify any deliberate follow-up work without silently expanding scope;
- contain only changes needed for the selected issue.

Do not merge the pull request. Report its URL and any remaining CI or review state to the user.

## Engineering principles

- Keep the system self-hosted, local-network friendly, and suitable for 24/7 operation on modest hardware.
- Preserve API-first boundaries between the bot, server, gallery, and administration client.
- Treat uploaded files and Telegram input as untrusted.
- Never commit credentials, tokens, uploaded media, databases, or local environment files.
- Prefer small, reviewable changes with explicit failure handling.
- Do not implement future-scope features unless a GitHub issue explicitly requests them.
