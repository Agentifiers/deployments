import "@tanstack/react-start/server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  makeDynamoDatabase,
  makeIdentityRepository,
  makeIdGenerator,
  makeKmsEnvelopeAdapter,
} from "@deployments-ai/db";
import {
  type ClientSecretSource,
  makeOidcClient,
  makeWebBffAuth,
  WEB_BFF_CLIENT_ID,
} from "@deployments-ai/web-bff-auth";
import { signOutBrowser } from "../account-actions.ts";
import { type ConsoleConfig, consoleConfig } from "../config.ts";
import type { AuthRouteContext } from "./handlers.ts";
import { CONSOLE_OAUTH_SCOPES } from "./scopes.ts";

/**
 * The `deployments-web` client secret, read from its Parameter Store SecureString once per
 * container. An `invalid_client` answer drops the cached value so a new secret is picked up.
 */
function parameterClientSecret(parameterArn: string): ClientSecretSource {
  const client = new SSMClient({});
  let cached: Promise<string> | undefined;
  return {
    current: () => {
      cached ??= client
        .send(new GetParameterCommand({ Name: parameterArn, WithDecryption: true }))
        .then((result) => {
          const value = result.Parameter?.Value;
          if (!value) throw new Error("The web client secret parameter has no value.");
          return value;
        })
        .catch((error: unknown) => {
          cached = undefined;
          throw error;
        });
      return cached;
    },
    invalidate: () => {
      cached = undefined;
    },
  };
}

function buildAuthRouteContext(config: ConsoleConfig): AuthRouteContext {
  const redirectUri = `${config.publicOrigin}/auth/callback`;
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    { ...DEFAULT_TABLE_NAMES, identity: config.identityTableName },
  );
  const ids = makeIdGenerator();
  const auth = makeWebBffAuth({
    // The issuer host stands in for the stage: it is unique per deployment environment.
    envelope: makeKmsEnvelopeAdapter({
      keyId: config.sessionKmsKeyArn,
      kms: new KMSClient({}),
      stage: new URL(config.identityIssuer).host,
    }),
    generateId: () => ids.generate(),
    issuer: config.identityIssuer,
    oidc: makeOidcClient({
      clientId: WEB_BFF_CLIENT_ID,
      clientSecret: parameterClientSecret(config.webClientSecretArn),
      issuer: config.identityIssuer,
      redirectUri,
    }),
    // Non-secret transitions only; feeds log-based metrics for initiate/consume/lease/reauth.
    onEvent: (event) => console.info(JSON.stringify({ component: "web-bff-auth", ...event })),
    redirectUri,
    repository: makeIdentityRepository(database),
    scopes: CONSOLE_OAUTH_SCOPES,
  });
  return { auth, endIssuerSession: signOutBrowser, publicOrigin: config.publicOrigin };
}

let context: AuthRouteContext | undefined;

/** The process-wide BFF composition, built on first use from the validated configuration. */
export function authRouteContext(): AuthRouteContext {
  context ??= buildAuthRouteContext(consoleConfig());
  return context;
}
