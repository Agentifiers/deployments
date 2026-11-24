export interface DurableStreamsRuntimeConfig {
  readonly authToken: string;
  readonly dataDir: string;
  readonly host: string;
  readonly longPollTimeoutMs: number;
  readonly port: number;
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Durable Streams port must be an integer from 1 through 65535.`);
  }
  return parsed;
}

function requiredPath(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (!normalized.startsWith("/") || normalized.includes("\u0000")) {
    throw new Error("Durable Streams data directory must be an absolute path.");
  }
  return normalized.replace(/\/+$/u, "") || "/";
}

function host(value: string | undefined): string {
  const normalized = value?.trim() || "0.0.0.0";
  if (/[/\s]/u.test(normalized) || normalized.includes("\u0000")) {
    throw new Error("Durable Streams host is invalid.");
  }
  return normalized;
}

function requiredToken(value: string | undefined): string {
  const token = value?.trim();
  if (!token || token.length < 32) {
    throw new Error("Durable Streams auth token must contain at least 32 characters.");
  }
  return token;
}

export function durableStreamsRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DurableStreamsRuntimeConfig {
  return {
    authToken: requiredToken(
      environment.DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_TOKEN ??
        environment.DURABLE_STREAMS_AUTH_TOKEN,
    ),
    dataDir: requiredPath(
      environment.DEPLOYMENTS_AI_DURABLE_STREAMS_DATA_DIR ?? environment.DURABLE_STREAMS_DATA_DIR,
      "/data",
    ),
    host: host(environment.DEPLOYMENTS_AI_DURABLE_STREAMS_HOST ?? environment.HOST),
    longPollTimeoutMs: optionalPositiveInteger(
      environment.DEPLOYMENTS_AI_DURABLE_STREAMS_LONG_POLL_TIMEOUT_MS,
      20_000,
    ),
    port: optionalPositiveInteger(
      environment.DEPLOYMENTS_AI_DURABLE_STREAMS_PORT ?? environment.PORT,
      4437,
    ),
  };
}
