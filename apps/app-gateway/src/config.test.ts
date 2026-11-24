import { describe, expect, test } from "bun:test";
import { appGatewayConfiguration } from "./config.ts";
import { callLimiting } from "./index.ts";

const ENVIRONMENT = {
  APPS_BUCKET: "deployments-dev-apps",
  APPS_DATABASE_HOST: "apps.cluster-abc.us-east-2.rds.amazonaws.com",
  APPS_DATABASE_PORT: "5432",
  APPS_DATABASE_REGION: "us-east-2",
  APPS_DOMAIN: "apps.example.com",
  APPS_OAUTH_CLIENT_ID: "deployments-apps",
  APPS_OAUTH_CLIENT_SECRET_ARN:
    "arn:aws:ssm:us-east-2:123456789012:parameter/identity/apps-dev-oauth-client",
  DEPLOYMENTS_AI_CONTROL_TABLE: "deployments-dev-control",
  DEPLOYMENTS_AI_IDENTITY_ISSUER: "https://auth.example.com",
  DEPLOYMENTS_AI_IDENTITY_TABLE: "deployments-dev-identity",
};

function failure(overrides: Record<string, string | undefined>) {
  try {
    appGatewayConfiguration({ ...ENVIRONMENT, ...overrides });
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("appGatewayConfiguration", () => {
  test("reads the gateway environment the app-runtime module sets", () => {
    expect(appGatewayConfiguration(ENVIRONMENT)).toEqual({
      appsBucket: "deployments-dev-apps",
      appsDomain: "apps.example.com",
      clientId: "deployments-apps",
      clientSecretArn:
        "arn:aws:ssm:us-east-2:123456789012:parameter/identity/apps-dev-oauth-client",
      database: {
        host: "apps.cluster-abc.us-east-2.rds.amazonaws.com",
        port: 5432,
        region: "us-east-2",
      },
      issuer: "https://auth.example.com",
      port: 8080,
      tables: {
        control: "deployments-dev-control",
        events: "events",
        execution: "execution",
        identity: "deployments-dev-identity",
        "identity-email-outbox": "identity-email-outbox",
        usage: "usage",
      },
      visitorLimits: {
        address: { burst: 10, perMinute: 10 },
        app: { burst: 120, perMinute: 300 },
        bodyMaxBytes: 16_384,
        callsPerApp: 2,
        callsTotal: 16,
        page: { burst: 60, perMinute: 300 },
      },
    });
  });

  test("reads visitor limits from the environment and refuses caps that cannot hold", () => {
    expect({
      configured: appGatewayConfiguration({
        ...ENVIRONMENT,
        APPS_VISITOR_ADDRESS_BURST: "5",
        APPS_VISITOR_ADDRESS_PER_MINUTE: "20",
        APPS_VISITOR_APP_BURST: "60",
        APPS_VISITOR_APP_PER_MINUTE: "600",
        APPS_VISITOR_BODY_MAX_BYTES: "1048576",
        APPS_VISITOR_CALLS_PER_APP: "1",
        APPS_VISITOR_CALLS_TOTAL: "32",
        APPS_VISITOR_PAGE_BURST: "30",
        APPS_VISITOR_PAGE_PER_MINUTE: "120",
      }).visitorLimits,
      refused: [
        failure({ APPS_VISITOR_ADDRESS_BURST: "0" }),
        failure({ APPS_VISITOR_APP_PER_MINUTE: "2.5" }),
        ...["1e3", "0x10", "+5", "1.0", "05", "9007199254740993"].map((value) =>
          failure({ APPS_VISITOR_PAGE_BURST: value }),
        ),
        failure({ APPS_VISITOR_CALLS_PER_APP: "3" }),
        failure({ APPS_VISITOR_CALLS_PER_APP: "2", APPS_VISITOR_CALLS_TOTAL: "1" }),
        failure({ APPS_VISITOR_CALLS_TOTAL: "33" }),
        failure({ APPS_VISITOR_BODY_MAX_BYTES: "1048577" }),
      ],
    }).toEqual({
      configured: {
        address: { burst: 5, perMinute: 20 },
        app: { burst: 60, perMinute: 600 },
        bodyMaxBytes: 1_048_576,
        callsPerApp: 1,
        callsTotal: 32,
        page: { burst: 30, perMinute: 120 },
      },
      refused: [
        "APPS_VISITOR_ADDRESS_BURST must be a positive decimal integer.",
        "APPS_VISITOR_APP_PER_MINUTE must be a positive decimal integer.",
        ...Array.from(
          { length: 6 },
          () => "APPS_VISITOR_PAGE_BURST must be a positive decimal integer.",
        ),
        "APPS_VISITOR_CALLS_PER_APP must not exceed the 2 connections of an app's visitor pool.",
        "APPS_VISITOR_CALLS_PER_APP must not exceed APPS_VISITOR_CALLS_TOTAL.",
        "APPS_VISITOR_CALLS_TOTAL must not exceed 32, half of the gateway's 64 call slots, so members keep the other half.",
        "APPS_VISITOR_BODY_MAX_BYTES must not exceed the gateway's 1048576-byte request limit.",
      ],
    });
  });

  test("the per-app visitor share, the process-wide visitor cap and the page burst come from the configuration", async () => {
    const { limits, visitors } = callLimiting({
      limits: appGatewayConfiguration({
        ...ENVIRONMENT,
        APPS_VISITOR_CALLS_PER_APP: "1",
        APPS_VISITOR_CALLS_TOTAL: "3",
        APPS_VISITOR_PAGE_BURST: "2",
      }).visitorLimits,
      now: () => new Date(0),
      waitMs: 1,
    });
    const held = Promise.withResolvers<void>();
    const holding = [limits.visitor("a", () => held.promise)];
    const overShare = await limits.visitor("a", async () => "ran");
    holding.push(...["b", "c"].map((app) => limits.visitor(app, () => held.promise)));
    const overCap = await limits.visitor("d", async () => "ran");
    const member = await limits.caller("d/viewer", async () => "ran");
    held.resolve();
    await Promise.all(holding);

    expect({
      member: member.kind,
      overCap: overCap.kind,
      overShare: overShare.kind,
      pages: ["198.51.100.1", "198.51.100.1", "198.51.100.1"].map((key) => visitors.page(key).kind),
    }).toEqual({
      member: "done",
      overCap: "busy",
      overShare: "busy",
      pages: ["allowed", "allowed", "limited"],
    });
  });

  test("refuses a missing table, an http issuer, and a domain with a scheme", () => {
    expect([
      failure({ DEPLOYMENTS_AI_IDENTITY_TABLE: undefined }),
      failure({ DEPLOYMENTS_AI_IDENTITY_ISSUER: "http://auth.example.com" }),
      failure({ APPS_DOMAIN: "https://apps.example.com" }),
    ]).toEqual([
      "DEPLOYMENTS_AI_IDENTITY_TABLE is required.",
      "DEPLOYMENTS_AI_IDENTITY_ISSUER must be an https URL without a trailing slash.",
      "APPS_DOMAIN must be a lowercase DNS name.",
    ]);
  });
});
