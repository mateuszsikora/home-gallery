/** A single misconfigured environment variable and why it was rejected. */
export interface ConfigurationIssue {
  variable: string;
  message: string;
}

const formatIssues = (issues: readonly ConfigurationIssue[]): string =>
  issues.map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n');

/**
 * Thrown when environment configuration cannot be turned into a usable value.
 * The message lists every offending variable so an operator can fix the
 * deployment in one pass instead of restarting after each individual failure.
 */
export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(summary: string, issues: readonly ConfigurationIssue[]) {
    super(
      issues.length > 0
        ? `${summary}:\n${formatIssues(issues)}`
        : `${summary}.`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}
