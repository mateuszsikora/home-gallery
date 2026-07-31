# Agent Workflow

## Minimal session prompt

Start a new Conductor session and enter:

> Read the Markdown files and continue the project.

No issue number is required. `AGENTS.md` instructs the agent to inspect GitHub, choose the next unblocked issue, implement only that issue, validate the work, and open a pull request against `main`.

## Expected session outcome

A successful implementation session produces:

1. one selected GitHub issue;
2. one focused set of code and test changes;
3. successful relevant validation commands;
4. one pushed workspace branch;
5. one pull request containing `Closes #<issue-number>`.

If every open issue is blocked, the agent must explain the dependency or missing authority instead of inventing work. If an open pull request already implements the next issue, the agent must leave it alone and select another ready issue.

## Human review

Before merging, verify the riskiest behavior described in the issue, inspect the full branch diff, and check CI. Merge only after the issue acceptance criteria are demonstrably satisfied. New Conductor repository settings take effect for new workspaces after the settings change is merged to the default branch.
