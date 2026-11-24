import { DEFAULT_LIMITS } from "@deployments-ai/app-database";
import { tableNamesFromEnvironment, type TableNames } from "@deployments-ai/db";
import { MAXIMUM_BODY_BYTES } from "./api-calls.ts";
import type { RateLimit } from "./visitor-calls.ts";

const APP_GATEWAY_ENV = {
  appsBucket: "APPS_BUCKET",
  appsDomain: "APPS_DOMAIN",
  clientId: "APPS_OAUTH_CLIENT_ID",
  clientSecretArn: "APPS_OAUTH_CLIENT_SECRET_ARN",
  controlTable: "DEPLOYMENTS_AI_CONTROL_TABLE",
  databaseHost: "APPS_DATABASE_HOST",
  databasePort: "APPS_DATABASE_PORT",
  databaseRegion: "APPS_DATABASE_REGION",
  identityTable: "DEPLOYMENTS_AI_IDENTITY_TABLE",
  issuer: "DEPLOYMENTS_AI_IDENTITY_ISSUER",
  port: "PORT",
} as const;

export const VISITOR_LIMIT_ENV = {
  addressBurst: "APPS_VISITOR_ADDRESS_BURST",
  addressPerMinute: "APPS_VISITOR_ADDRESS_PER_MINUTE",
  appBurst: "APPS_VISITOR_APP_BURST",
  appPerMinute: "APPS_VISITOR_APP_PER_MINUTE",
  bodyMaxBytes: "APPS_VISITOR_BODY_MAX_BYTES",
  callsPerApp: "APPS_VISITOR_CALLS_PER_APP",
  callsTotal: "APPS_VISITOR_CALLS_TOTAL",
  pageBurst: "APPS_VISITOR_PAGE_BURST",
  pagePerMinute: "APPS_VISITOR_PAGE_PER_MINUTE",
} as const;

export interface VisitorLimits {
  readonly address: RateLimit;
  readonly app: RateLimit;
  readonly bodyMaxBytes: number;
  readonly callsPerApp: number;
  readonly callsTotal: number;
  readonly page: RateLimit;
}

export const DEFAULT_VISITOR_LIMITS: VisitorLimits = {
  address: { burst: 10, perMinute: 10 },
  app: { burst: 120, perMinute: 300 },
  bodyMaxBytes: 16 * 1024,
  callsPerApp: DEFAULT_LIMITS.maxConnectionsPerPool.visitor,
  callsTotal: 16,
  page: { burst: 60, perMinute: 300 },
};

const DECIMAL_COUNT = /^[1-9][0-9]*$/u;

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u;

export interface AppGatewayConfiguration {
  readonly appsBucket: string;
  readonly appsDomain: string;
  readonly clientId: string;
  readonly clientSecretArn: string;
  readonly database: { readonly host: string; readonly port: number; readonly region: string };
  readonly issuer: string;
  readonly port: number;
  readonly tables: TableNames;
  readonly visitorLimits: VisitorLimits;
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function tcpPort(name: string, value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be a TCP port.`);
  }
  return parsed;
}

function visitorLimits(environment: NodeJS.ProcessEnv): VisitorLimits {
  const count = (key: keyof typeof VISITOR_LIMIT_ENV, fallback: number) => {
    const name = VISITOR_LIMIT_ENV[key];
    const value = environment[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!DECIMAL_COUNT.test(value) || !Number.isSafeInteger(parsed)) {
      throw new Error(`${name} must be a positive decimal integer.`);
    }
    return parsed;
  };
  const defaults = DEFAULT_VISITOR_LIMITS;
  const limits: VisitorLimits = {
    address: {
      burst: count("addressBurst", defaults.address.burst),
      perMinute: count("addressPerMinute", defaults.address.perMinute),
    },
    app: {
      burst: count("appBurst", defaults.app.burst),
      perMinute: count("appPerMinute", defaults.app.perMinute),
    },
    bodyMaxBytes: count("bodyMaxBytes", defaults.bodyMaxBytes),
    callsPerApp: count("callsPerApp", defaults.callsPerApp),
    callsTotal: count("callsTotal", defaults.callsTotal),
    page: {
      burst: count("pageBurst", defaults.page.burst),
      perMinute: count("pagePerMinute", defaults.page.perMinute),
    },
  };
  const visitorPool = DEFAULT_LIMITS.maxConnectionsPerPool.visitor;
  if (limits.callsPerApp > visitorPool) {
    throw new Error(
      `${VISITOR_LIMIT_ENV.callsPerApp} must not exceed the ${visitorPool} connections of an app's visitor pool.`,
    );
  }
  if (limits.callsPerApp > limits.callsTotal) {
    throw new Error(
      `${VISITOR_LIMIT_ENV.callsPerApp} must not exceed ${VISITOR_LIMIT_ENV.callsTotal}.`,
    );
  }
  const visitorShare = DEFAULT_LIMITS.maxConnectionsTotal / 2;
  if (limits.callsTotal > visitorShare) {
    throw new Error(
      `${VISITOR_LIMIT_ENV.callsTotal} must not exceed ${visitorShare}, half of the gateway's ${DEFAULT_LIMITS.maxConnectionsTotal} call slots, so members keep the other half.`,
    );
  }
  if (limits.bodyMaxBytes > MAXIMUM_BODY_BYTES) {
    throw new Error(
      `${VISITOR_LIMIT_ENV.bodyMaxBytes} must not exceed the gateway's ${MAXIMUM_BODY_BYTES}-byte request limit.`,
    );
  }
  return limits;
}

export function appGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AppGatewayConfiguration {
  const appsDomain = required(environment, APP_GATEWAY_ENV.appsDomain);
  if (!HOSTNAME.test(appsDomain)) {
    throw new Error(`${APP_GATEWAY_ENV.appsDomain} must be a lowercase DNS name.`);
  }
  const issuer = required(environment, APP_GATEWAY_ENV.issuer);
  const issuerUrl = URL.parse(issuer);
  if (issuerUrl?.protocol !== "https:" || issuerUrl.href.replace(/\/$/u, "") !== issuer) {
    throw new Error(`${APP_GATEWAY_ENV.issuer} must be an https URL without a trailing slash.`);
  }
  required(environment, APP_GATEWAY_ENV.controlTable);
  required(environment, APP_GATEWAY_ENV.identityTable);
  return {
    appsBucket: required(environment, APP_GATEWAY_ENV.appsBucket),
    appsDomain,
    clientId: required(environment, APP_GATEWAY_ENV.clientId),
    clientSecretArn: required(environment, APP_GATEWAY_ENV.clientSecretArn),
    database: {
      host: required(environment, APP_GATEWAY_ENV.databaseHost),
      port: tcpPort(
        APP_GATEWAY_ENV.databasePort,
        required(environment, APP_GATEWAY_ENV.databasePort),
      ),
      region: required(environment, APP_GATEWAY_ENV.databaseRegion),
    },
    issuer,
    port: tcpPort(APP_GATEWAY_ENV.port, environment[APP_GATEWAY_ENV.port]?.trim() || "8080"),
    tables: tableNamesFromEnvironment(environment),
    visitorLimits: visitorLimits(environment),
  };
}
