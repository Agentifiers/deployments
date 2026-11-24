export class SlackAgentStreamInitializationRetryableError extends Error {
  constructor(cause: unknown) {
    super("Slack agent stream initialization could not be durably reconciled.", { cause });
    this.name = "SlackAgentStreamInitializationRetryableError";
  }
}

export class SlackAgentStreamAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackAgentStreamAuthorizationError";
  }
}
