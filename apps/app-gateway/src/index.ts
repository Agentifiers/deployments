import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createAppApiGateway,
  DEFAULT_LIMITS,
  rdsConnectionSettings,
} from "@deployments-ai/app-database";
import {
  makeAppPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  makeOrganizationHoldReader,
} from "@deployments-ai/db";
import { systemRandom } from "@deployments-ai/identity";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeOidcClient } from "@deployments-ai/web-bff-auth";
import { apiCallLimits, MAXIMUM_BODY_BYTES, type ApiCallLimits } from "./api-calls.ts";
import { cachedClientSecret, s3ReleaseFiles } from "./aws.ts";
import { appGatewayConfiguration, type VisitorLimits } from "./config.ts";
import { createAppGateway } from "./gateway.ts";
import { cachedLookups, liveMemberAccess, liveSessionEpoch } from "./lookups.ts";
import { makePlatformSignIn } from "./platform-identity.ts";
import { tokenBuckets, VISITOR_DEADLINE_MS, type VisitorGate } from "./visitor-calls.ts";

const API_CALL_WAIT_MS = 3_000;
/** Rides out an Aurora resume, about 15 to 30 s, within the edge's 60 s origin read timeout. */
const DATABASE_RESUME_WAIT_MS = 30_000;
/** Bun's default 10 s would close a request still waiting out a resume; the edge waits 60 s. */
const SOCKET_IDLE_TIMEOUT_SECONDS = 60;

export function callLimiting(input: {
  readonly limits: VisitorLimits;
  readonly now: () => Date;
  readonly waitMs: number;
}): { readonly limits: ApiCallLimits; readonly visitors: VisitorGate } {
  const { limits, now } = input;
  return {
    limits: apiCallLimits({
      callerShare: DEFAULT_LIMITS.maxConnectionsPerPool.editor,
      total: DEFAULT_LIMITS.maxConnectionsTotal,
      visitorShare: limits.callsPerApp,
      visitorTotal: limits.callsTotal,
      waitMs: input.waitMs,
    }),
    visitors: {
      address: tokenBuckets({ limit: limits.address, now }),
      app: tokenBuckets({ limit: limits.app, now }),
      bodyMaxBytes: limits.bodyMaxBytes,
      deadlineMs: VISITOR_DEADLINE_MS,
      page: tokenBuckets({ limit: limits.page, now }),
    },
  };
}

export async function startAppGateway(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = appGatewayConfiguration(environment);
  const { visitorLimits } = configuration;
  const now = () => new Date();
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    configuration.tables,
  );
  const apps = makeAppPersistence({ database, generateId: makeIdGenerator().generate, now });
  const redirectUri = `https://${configuration.appsDomain}/_platform/auth/callback`;
  const appDatabase = createAppApiGateway({
    connections: rdsConnectionSettings({
      ...configuration.database,
      resumeWaitMs: DATABASE_RESUME_WAIT_MS,
    }),
  });
  const sessionEpoch = liveSessionEpoch(database);
  const server = Bun.serve({
    fetch: createAppGateway({
      apps,
      appsDomain: configuration.appsDomain,
      currentSessionEpoch: sessionEpoch,
      database: appDatabase,
      identity: makePlatformSignIn({
        clientId: configuration.clientId,
        issuer: configuration.issuer,
        oidc: makeOidcClient({
          clientId: configuration.clientId,
          clientSecret: cachedClientSecret(() =>
            loadAwsSecretString(configuration.clientSecretArn),
          ),
          issuer: configuration.issuer,
          redirectUri,
        }),
        redirectUri,
      }),
      ...callLimiting({ limits: visitorLimits, now, waitMs: API_CALL_WAIT_MS }),
      log: (entry) => console.info(JSON.stringify(entry)),
      lookups: cachedLookups({
        apps,
        memberAccess: liveMemberAccess(database),
        now,
        sessionEpoch,
        standing: makeOrganizationHoldReader(database),
      }),
      now,
      random: systemRandom,
      releases: s3ReleaseFiles({ bucket: configuration.appsBucket, client: new S3Client({}) }),
    }),
    hostname: "0.0.0.0",
    idleTimeout: SOCKET_IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: MAXIMUM_BODY_BYTES,
    port: configuration.port,
  });
  // The load balancer drains the task before SIGTERM.
  const stop = async () => {
    await server.stop();
    await appDatabase.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.info(JSON.stringify({ event: "app_gateway.listening", port: server.port }));
  return { server, stop };
}

if (import.meta.main) {
  startAppGateway().catch((cause: unknown) => {
    console.error(
      JSON.stringify({
        event: "app_gateway.start_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    process.exitCode = 1;
  });
}
