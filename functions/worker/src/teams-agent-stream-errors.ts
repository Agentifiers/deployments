import {
  TeamsBotAuthenticationError,
  TeamsConnectorError,
} from "@deployments-ai/channel-adapters/teams";

export class TeamsAgentStreamInitializationRetryableError extends Error {
  constructor(cause: unknown) {
    super("Teams agent stream initialization could not be durably reconciled.", { cause });
    this.name = "TeamsAgentStreamInitializationRetryableError";
  }
}

export class TeamsAgentStreamAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsAgentStreamAuthorizationError";
  }
}

/** Teams accepted the stream start but returned no stream id; the outcome is ambiguous. */
export class TeamsAgentStreamMissingIdError extends Error {
  constructor() {
    super("Teams stream start was accepted without a stream id.");
    this.name = "TeamsAgentStreamMissingIdError";
  }
}

/** Teams received the activity request and definitively did not apply it (400/403/404). */
export function teamsDefinitiveRejection(cause: unknown) {
  return (
    cause instanceof TeamsConnectorError && cause.stage === "connector" && cause.definitiveRejection
  );
}

/**
 * A stream start that never reached Teams (its bot token request failed) or that Teams
 * definitively rejected leaves no visible stream message, so a fallback post cannot duplicate it.
 */
export function teamsStartSafeToFallback(cause: unknown) {
  return (
    teamsDefinitiveRejection(cause) ||
    cause instanceof TeamsBotAuthenticationError ||
    (cause instanceof TeamsConnectorError && cause.stage === "authentication")
  );
}
