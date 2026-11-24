import "@tanstack/react-start/server-only";

/** Runtime configuration the console Lambda reads from its environment. */
export interface ConsoleConfig {
  /** Browser-facing console origin (`CONSOLE_PUBLIC_ORIGIN`), e.g. `https://app.example.com`. */
  readonly publicOrigin: string;
  /** Platform API origin (`CONSOLE_PLATFORM_API_URL`) every server function calls. */
  readonly platformApiUrl: string;
  /** Platform identity issuer URL (`CONSOLE_IDENTITY_ISSUER`), compared verbatim with `iss`. */
  readonly identityIssuer: string;
  /** DynamoDB identity table holding BFF authorization/session records (`CONSOLE_IDENTITY_TABLE_NAME`). */
  readonly identityTableName: string;
  /** Parameter Store ARN of the `deployments-web` client secret (`CONSOLE_WEB_CLIENT_SECRET_ARN`). */
  readonly webClientSecretArn: string;
  /** KMS key ARN for BFF session envelopes (`CONSOLE_SESSION_KMS_KEY_ARN`). */
  readonly sessionKmsKeyArn: string;
  /**
   * Origin of the channel/provider public API (`CONSOLE_OAUTH_CALLBACK_ORIGIN`). It serves provider
   * OAuth callbacks and channel ingress, so the console shows the redirect URI to register with a
   * provider and each binding's ingress URL from it. Unset when the deployment runs no channel
   * provider runtime.
   */
  readonly oauthCallbackOrigin?: string;
  /** Public stream gateway origin (`CONSOLE_STREAM_GATEWAY_URL`); unset without an agent runtime. */
  readonly streamGatewayUrl?: string;
  /** Documentation site origin (`CONSOLE_DOCS_ORIGIN`); unset hides links to the docs. */
  readonly docsOrigin?: string;
}

export type ConsoleEnvironment = Readonly<Record<string, string | undefined>>;

export class ConsoleConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid console configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConsoleConfigError";
    this.problems = problems;
  }
}

function isLoopbackHostname(hostname: string) {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
}

/** Reads one absolute HTTPS URL (HTTP only for loopback hosts) without credentials or fragment. */
function readUrl(environment: ConsoleEnvironment, name: string, problems: string[]) {
  const value = environment[name]?.trim();
  if (!value) {
    problems.push(`${name} is required.`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} must be an absolute URL; received "${value}".`);
    return undefined;
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    problems.push(`${name} must use HTTPS (HTTP is accepted only for loopback hosts).`);
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) {
    problems.push(`${name} must not contain credentials, a query, or a fragment.`);
    return undefined;
  }
  return { url, value };
}

function readOrigin(environment: ConsoleEnvironment, name: string, problems: string[]) {
  const parsed = readUrl(environment, name, problems);
  if (!parsed) return undefined;
  if (parsed.url.pathname !== "/") {
    problems.push(`${name} must be an origin without a path; received "${parsed.value}".`);
    return undefined;
  }
  return parsed.url.origin;
}

function readPattern(
  environment: ConsoleEnvironment,
  name: string,
  pattern: RegExp,
  description: string,
  problems: string[],
) {
  const value = environment[name]?.trim();
  if (!value) {
    problems.push(`${name} is required.`);
    return undefined;
  }
  if (!pattern.test(value)) {
    problems.push(`${name} must be ${description}; received "${value}".`);
    return undefined;
  }
  return value;
}

/**
 * Validates the console environment and reports every problem at once. Add new variables as a
 * field on `ConsoleConfig` plus one `read*` call here.
 */
export function parseConsoleConfig(environment: ConsoleEnvironment): ConsoleConfig {
  const problems: string[] = [];
  const publicOrigin = readOrigin(environment, "CONSOLE_PUBLIC_ORIGIN", problems);
  const platformApiUrl = readOrigin(environment, "CONSOLE_PLATFORM_API_URL", problems);
  const identityIssuer = readUrl(environment, "CONSOLE_IDENTITY_ISSUER", problems)?.value;
  const identityTableName = readPattern(
    environment,
    "CONSOLE_IDENTITY_TABLE_NAME",
    /^[A-Za-z0-9_.-]{3,255}$/u,
    "a DynamoDB table name",
    problems,
  );
  const webClientSecretArn = readPattern(
    environment,
    "CONSOLE_WEB_CLIENT_SECRET_ARN",
    /^arn:aws[a-z-]*:ssm:[a-z0-9-]+:\d{12}:parameter\/.+$/u,
    "a Parameter Store parameter ARN",
    problems,
  );
  const sessionKmsKeyArn = readPattern(
    environment,
    "CONSOLE_SESSION_KMS_KEY_ARN",
    /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/.+$/u,
    "a KMS key or alias ARN",
    problems,
  );
  const optionalOrigin = (name: string) =>
    environment[name]?.trim() ? readOrigin(environment, name, problems) : undefined;
  const oauthCallbackOrigin = optionalOrigin("CONSOLE_OAUTH_CALLBACK_ORIGIN");
  const streamGatewayUrl = optionalOrigin("CONSOLE_STREAM_GATEWAY_URL");
  const docsOrigin = optionalOrigin("CONSOLE_DOCS_ORIGIN");
  if (
    !publicOrigin ||
    !platformApiUrl ||
    !identityIssuer ||
    !identityTableName ||
    !webClientSecretArn ||
    !sessionKmsKeyArn ||
    problems.length > 0
  ) {
    throw new ConsoleConfigError(problems);
  }
  return {
    identityIssuer,
    identityTableName,
    platformApiUrl,
    publicOrigin,
    sessionKmsKeyArn,
    webClientSecretArn,
    ...(oauthCallbackOrigin ? { oauthCallbackOrigin } : {}),
    ...(streamGatewayUrl ? { streamGatewayUrl } : {}),
    ...(docsOrigin ? { docsOrigin } : {}),
  };
}

let loaded: ConsoleConfig | undefined;

/** The validated configuration of this process; the server entry loads it at startup. */
export function consoleConfig(): ConsoleConfig {
  loaded ??= parseConsoleConfig(process.env);
  return loaded;
}
