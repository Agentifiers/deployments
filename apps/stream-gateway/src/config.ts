const STREAM_GATEWAY_ENV = {
  allowedOrigins: "DEPLOYMENTS_AI_STREAM_GATEWAY_ALLOWED_ORIGINS",
  durableAuthSecretArn: "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN",
  durableBaseUrl: "DEPLOYMENTS_AI_DURABLE_STREAMS_URL",
  port: "PORT",
  sessionSecretArn: "DEPLOYMENTS_AI_STREAM_SESSION_SECRET_ARN",
} as const;

export interface StreamGatewayConfiguration {
  readonly allowedOrigins: readonly string[];
  readonly durableAuthSecretArn: string;
  readonly durableBaseUrl: string;
  readonly port: number;
  readonly sessionSecretArn: string;
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function port(value: string | undefined) {
  if (!value?.trim()) return 8080;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${STREAM_GATEWAY_ENV.port} must be a positive TCP port.`);
  }
  return parsed;
}

const LOOPBACK_HOSTNAMES: Record<string, true> = {
  "127.0.0.1": true,
  "[::1]": true,
  localhost: true,
};

function allowedOrigin(entry: string) {
  const url = URL.parse(entry);
  const wildcard = url?.hostname.startsWith("*.") === true;
  if (
    url?.origin === entry &&
    !url.hostname.slice(wildcard ? 2 : 0).includes("*") &&
    (url.protocol === "https:" ||
      (!wildcard && url.protocol === "http:" && LOOPBACK_HOSTNAMES[url.hostname] === true))
  ) {
    return entry;
  }
  throw new Error(
    `${STREAM_GATEWAY_ENV.allowedOrigins} entries must be exact https origins, https://*.<domain> for one DNS label, or http origins on a loopback host; got "${entry}".`,
  );
}

function allowedOrigins(value: string | undefined) {
  const list = value?.trim();
  return list ? list.split(",").map((entry) => allowedOrigin(entry.trim())) : [];
}

export function streamGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StreamGatewayConfiguration {
  return {
    allowedOrigins: allowedOrigins(environment[STREAM_GATEWAY_ENV.allowedOrigins]),
    durableAuthSecretArn: required(environment, STREAM_GATEWAY_ENV.durableAuthSecretArn),
    durableBaseUrl: required(environment, STREAM_GATEWAY_ENV.durableBaseUrl),
    port: port(environment[STREAM_GATEWAY_ENV.port]),
    sessionSecretArn: required(environment, STREAM_GATEWAY_ENV.sessionSecretArn),
  };
}
