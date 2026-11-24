import { expect, test } from "bun:test";
import { appGatewayConfiguration, VISITOR_LIMIT_ENV } from "../apps/app-gateway/src/config.ts";
import { blockAt, readTerraformFiles } from "./terraform-files.ts";

const appRuntime = readTerraformFiles("infrastructure/modules/app-runtime", "");

const GATEWAY_ENVIRONMENT = {
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

test("the app-runtime module sets every visitor limit the gateway reads, to the documented values", () => {
  const environment = blockAt(appRuntime, appRuntime.indexOf("gateway_environment = {"));
  const configured = Object.fromEntries(
    [...environment.matchAll(/^\s+(APPS_VISITOR_[A-Z_]+)\s*=\s*"([^"]*)"$/gmu)].map((match) => [
      match[1],
      match[2],
    ]),
  );

  expect({
    names: Object.keys(configured).sort(),
    parsed: appGatewayConfiguration({ ...GATEWAY_ENVIRONMENT, ...configured }).visitorLimits,
  }).toEqual({
    names: Object.values(VISITOR_LIMIT_ENV).sort(),
    parsed: {
      address: { burst: 10, perMinute: 10 },
      app: { burst: 120, perMinute: 300 },
      bodyMaxBytes: 16_384,
      callsPerApp: 2,
      callsTotal: 16,
      page: { burst: 60, perMinute: 300 },
    },
  });
});
